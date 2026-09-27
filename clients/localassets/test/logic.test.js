/**
 * Tests for the resolution logic of the local assets client.
 *
 * The tests build real MPQ archives with the library's own parser, so the MPQ tier is exercised
 * end to end (hash table, (listfile), lazy loading and all).
 *
 * Bundling is needed because this is a browser client module written in ESM importing TypeScript:
 *
 *   node node_modules/webpack/bin/webpack.js --mode=development --target=node \
 *     --entry ./clients/localassets/test/logic.test.js --output-path ./dist/test/localassets
 *   node ./dist/test/localassets/main.js
 */

import MpqArchive from '../../../src/parsers/mpq/archive';
import { normalizePath, directoryOf, resolveCandidates, createFileSource, resolveFromSources } from '../resolver';
import { createMpqSource } from '../mpqsource';

const results = [];

function check(name, condition, extra = '') {
  results.push(!!condition);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition || extra === '' ? '' : `  -> ${extra}`}`);
}

function equal(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

/**
 * Builds an in-memory MPQ archive out of {name: text} pairs.
 */
function buildArchive(files) {
  const archive = new MpqArchive();

  for (const [name, text] of Object.entries(files)) {
    archive.set(name, text);
  }

  const bytes = archive.save();

  if (!bytes) {
    throw new Error(`Failed to save archive`);
  }

  return bytes;
}

/**
 * A File stand-in, since the source only needs a name, a size and arrayBuffer().
 */
function fakeFile(name, bytes, relativePath = '') {
  return {
    name,
    size: bytes.byteLength,
    webkitRelativePath: relativePath,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function text(bytes) {
  return new TextDecoder().decode(bytes);
}

async function main() {
  // ---- Path helpers ----

  equal('normalizePath: 反斜杠/大小写/前导斜杠', normalizePath('\\Textures\\Foo.BLP'), 'textures/foo.blp');
  equal('normalizePath: ./ 前缀', normalizePath('./a//b/../c.blp'), 'a/b/../c.blp');
  equal('directoryOf', directoryOf('Units/Human/Footman/Footman.mdx'), 'units/human/footman/');

  const candidates = resolveCandidates('Textures\\Foo.blp', 'Units/Human/Footman/');

  equal('候选路径: 模型目录优先', candidates.paths[0], 'units/human/footman/textures/foo.blp');
  equal('候选路径: 其次来源根目录', candidates.paths[1], 'textures/foo.blp');
  check('候选路径: 含扩展名互换', candidates.paths.includes('textures/foo.dds'), JSON.stringify(candidates.paths));
  check('候选文件名: 同名回退', candidates.names.includes('foo.blp') && candidates.names.includes('foo.dds'));

  // ---- File sources ----

  const dropped = createFileSource('拖入的文件', [
    { path: 'Textures/Foo.blp', read: () => new Uint8Array([1]) },
    { path: 'Units/Human/Footman/Textures/Rel.blp', read: () => new Uint8Array([2]) },
  ], { kind: 'dropped' });

  const textureDir = createFileSource('MyTextures', [
    { path: 'Textures/Foo.blp', read: () => new Uint8Array([3]) },
    { path: 'Models/Hero.dds', read: () => new Uint8Array([4]) },
  ]);

  const relative = await dropped.get('Textures\\Rel.blp', 'Units/Human/Footman/');

  equal('文件来源: 相对模型目录命中', relative && relative.path, 'units/human/footman/textures/rel.blp');

  const swapped = await textureDir.get('Models\\Hero.blp', '');

  equal('文件来源: 扩展名互换命中', swapped && swapped.path, 'models/hero.dds');

  // ---- MPQ sources ----

  const mpq = createMpqSource('MPQ');

  mpq.addFile(fakeFile('War3.mpq', buildArchive({
    'Textures\\Shared.blp': 'roc',
    'Units\\Human\\Footman\\Footman.blp': 'footman',
  }), 'Game/War3.mpq'));

  mpq.addFile(fakeFile('War3x.mpq', buildArchive({
    'Textures\\Shared.blp': 'tft',
    'Models\\Hero.dds': 'hd',
  }), 'Game/War3x.mpq'));

  equal('MPQ: 初始未解析任何归档', mpq.loadedCount(), 0);

  const shared = await mpq.get('Textures\\Shared.blp');

  equal('MPQ: 命中补丁/资料片归档（War3x 覆盖 War3）', shared && shared.source, 'MPQ:War3x.mpq');
  equal('MPQ: 同用时取到的是资料片内容', shared && text(shared.data), 'tft');
  equal('MPQ: 惰性加载（只解析了命中的归档）', mpq.loadedCount(), 1);

  const hero = await mpq.get('Models\\Hero.blp');

  equal('MPQ: 扩展名互换命中 .dds', hero && hero.path, 'models/hero.dds');
  equal('MPQ: 互换时读到的归档', hero && hero.source, 'MPQ:War3x.mpq');

  const footman = await mpq.get('footman.blp');

  equal('MPQ: 靠 (listfile) 同名回退', footman && footman.path, 'Units\\Human\\Footman\\Footman.blp');
  equal('MPQ: 同名回退读到的归档', footman && footman.source, 'MPQ:War3.mpq');

  const missing = await mpq.get('Textures\\Nope.blp');

  equal('MPQ: 找不到时返回 undefined', missing, undefined);

  // ---- Priority ----

  const all = [dropped, textureDir, mpq];

  const first = await resolveFromSources(all, 'Textures\\Foo.blp', '');

  equal('优先级: 拖入的文件 > 纹理目录 > MPQ', first && first.source, '拖入的文件');
  equal('优先级: 拖入的文件内容', first && first.data[0], 1);

  const second = await resolveFromSources([textureDir, mpq], 'Textures\\Foo.blp', '');

  equal('优先级: 去掉拖入文件后用纹理目录', second && second.source, 'MyTextures');
  equal('优先级: 纹理目录内容', second && second.data[0], 3);

  const third = await resolveFromSources([textureDir, mpq], 'Models\\Hero.dds', '');

  equal('优先级: 纹理目录压过 MPQ 里的同名文件', third && third.source, 'MyTextures');

  const fourth = await resolveFromSources([textureDir, mpq], 'Units\\Human\\Footman\\Footman.blp', '');

  equal('优先级: 前面的来源都没命中时落到 MPQ', fourth && fourth.source, 'MPQ:War3.mpq');
  equal('优先级: MPQ 内容', fourth && text(fourth.data), 'footman');

  const disabled = mpq.archives.find((entry) => entry.name === 'War3.mpq');

  disabled.enabled = false;

  const withoutBase = await resolveFromSources([textureDir, mpq], 'Units\\Human\\Footman\\Footman.blp', '');

  equal('MPQ: 取消勾选的归档不再参与查找', withoutBase, undefined);

  disabled.enabled = true;

  const failed = results.filter((ok) => !ok).length;

  console.log(`\n${results.length - failed}/${results.length} 个检查通过`);

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
