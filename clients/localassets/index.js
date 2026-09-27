/**
 * A local assets viewer.
 *
 * Drag a .mdx/.mdl (or a whole folder) onto the page to look at it, and configure where the
 * rest of its resources come from:
 *
 *   dropped files > texture directories (in order) > MPQ archives from the game directory
 *
 * See README.md in this directory for the details.
 */

import ModelViewer from '../../src/viewer/viewer';
import mdxHandler from '../../src/viewer/handlers/mdx/handler';
import blpHandler from '../../src/viewer/handlers/blp/handler';
import ddsHandler from '../../src/viewer/handlers/dds/handler';
import tgaHandler from '../../src/viewer/handlers/tga/handler';
import { setupCamera } from '../shared/camera';
import { createFileSource, resolveFromSources, directoryOf, normalizePath } from './resolver';
import { createMpqSource, formatSize } from './mpqsource';

const MODEL_EXTENSIONS = /\.(mdx|mdl)$/i;

const state = {
  viewer: null,
  scene: null,
  camera: null,
  viewerReforged: null,
  instance: null,
  // The currently loaded model: {name, path, buffer, dir}.
  model: null,
  // Files dropped into the page, in drop order: [{path, file}].
  dropped: [],
  // Cached source over state.dropped, rebuilt whenever the dropped files change.
  droppedSource: null,
  // Extra texture directories, in priority order.
  textures: [],
  // The MPQ tier, always the lowest priority source.
  mpq: createMpqSource('MPQ'),
  mode: 'auto',
  playing: true,
  pending: 0,
  missing: [],
  frames: 0,
  fpsTime: 0,
  fps: 0,
};

const ui = {};

// #region Logging and status

function log(message, kind = '') {
  const line = document.createElement('div');

  line.className = `log-line ${kind}`;
  line.textContent = message;

  ui.log.appendChild(line);

  while (ui.log.childElementCount > 500) {
    ui.log.removeChild(ui.log.firstChild);
  }

  ui.log.scrollTop = ui.log.scrollHeight;
}

function updateStatus() {
  const parts = [];

  if (state.model) {
    parts.push(state.model.name);
    parts.push(`${state.instance && state.instance.sequence >= 0 ? `动画 ${state.instance.sequence}` : '无动画'}`);
  } else {
    parts.push('把一个 .mdx / .mdl 拖到页面上');
  }

  const sources = [];

  if (state.dropped.length) {
    sources.push(`拖入 ${state.dropped.length} 个文件`);
  }

  if (state.textures.length) {
    sources.push(`${state.textures.length} 个纹理目录`);
  }

  if (state.mpq.count) {
    sources.push(`${state.mpq.count} 个 MPQ`);
  }

  parts.push(sources.length ? `来源: ${sources.join(' + ')}` : '来源: 无');

  if (state.pending) {
    parts.push(`加载中 ${state.pending}`);
  }

  if (state.missing.length) {
    parts.push(`缺失 ${state.missing.length}`);
  }

  parts.push(`${state.fps} FPS`);

  ui.status.textContent = parts.join('  |  ');
}

// #endregion

// #region Sources

/**
 * The sources in priority order, which is also the order they are displayed in.
 */
function sources() {
  const list = [];

  if (state.dropped.length) {
    if (!state.droppedSource) {
      state.droppedSource = createFileSource(
        '拖入的文件',
        state.dropped.map((entry) => ({ path: entry.path, read: () => readFile(entry.file) })),
        { kind: 'dropped' }
      );
    }

    list.push(state.droppedSource);
  }

  for (const source of state.textures) {
    list.push(source);
  }

  // MPQ is always the last source - it has the lowest priority.
  if (state.mpq.count) {
    list.push(state.mpq);
  }

  return list;
}

function readFile(file) {
  return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

function fileEntry(file) {
  return { path: file.webkitRelativePath || file.name, read: () => readFile(file) };
}

/**
 * The path solver given to the viewer and the MDX handler.
 *
 * It is called with the model's data for the initial load, and with texture paths afterwards.
 * Returning undefined makes the viewer drop the load, which is what a miss should do.
 */
async function pathSolver(src) {
  if (typeof src !== 'string') {
    return src;
  }

  const hit = await resolveFromSources(sources(), src, state.model ? state.model.dir : '', onSourceEvent);

  if (hit) {
    const detail = hit.path === normalizePath(src) ? '' : ` (${hit.path})`;

    log(`✓ ${src}  ←  ${hit.source}${detail}`, 'ok');

    return hit.data;
  }

  if (!state.missing.includes(src)) {
    state.missing.push(src);
  }

  log(`✗ ${src}  ←  所有来源都没有`, 'warn');
  updateStatus();

  return undefined;
}

function onSourceEvent(message, kind = '') {
  log(message, kind);
  // Archives change state while paths are being resolved, so the panel follows along.
  renderMpq();
}

// #endregion

// #region Viewer

/**
 * Replaces the canvas with a fresh one.
 *
 * WebGL gives one context per canvas, and the viewer bakes the TFT/Reforged mode into its
 * handlers, so the only way to switch modes (or to start over with clean caches) is a new canvas.
 */
function replaceCanvas() {
  const canvas = document.createElement('canvas');

  canvas.id = 'canvas';

  ui.canvas.replaceWith(canvas);
  ui.canvas = canvas;

  return canvas;
}

function createViewer(reforged) {
  const canvas = replaceCanvas();
  let viewer;

  try {
    viewer = new ModelViewer(canvas);
  } catch (e) {
    log(`创建查看器失败，WebGL 可能不可用: ${e.message || e}`, 'error');

    return null;
  }

  const scene = viewer.addScene();

  scene.color[0] = 0.1;
  scene.color[1] = 0.11;
  scene.color[2] = 0.13;

  // The path solver is given to the handler as well, since team colors/glows and event object
  // data are loaded by the handler itself.
  viewer.addHandler(mdxHandler, pathSolver, reforged);
  viewer.addHandler(blpHandler);
  viewer.addHandler(ddsHandler);
  viewer.addHandler(tgaHandler);

  viewer.on('loadstart', () => {
    state.pending++;
    updateStatus();
  });

  viewer.on('loadend', () => {
    state.pending = Math.max(0, state.pending - 1);
    updateStatus();
  });

  viewer.on('error', (e) => {
    const reason = e.reason && (e.reason.message || e.reason);

    log(`错误: ${e.error}${reason ? ` - ${reason}` : ''}`, 'error');
  });

  state.viewer = viewer;
  state.scene = scene;
  state.camera = setupCamera(scene, { distance: 500 });
  state.viewerReforged = reforged;
  state.instance = null;

  renderTeamColors();

  log(`创建查看器: ${reforged ? 'Reforged' : 'TFT'} 模式`, 'info');

  return viewer;
}

/**
 * Reads the model version out of the data, so that the viewer can be created in the right mode.
 *
 * Reforged models use version > 800, and use DDS textures and 28 team colors/glows.
 */
function readModelVersion(buffer) {
  if (!buffer || buffer.byteLength < 8) {
    return undefined;
  }

  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096));

  // MDX - "MDLX" magic, followed by the version.
  if (bytes[0] === 0x4D && bytes[1] === 0x44 && bytes[2] === 0x58 && bytes[3] === 0x4C) {
    return new DataView(buffer, 0, 8).getUint32(4, true);
  }

  // MDL - text, look for "Version { 800 }".
  const match = /version\s*\{?\s*(\d+)/i.exec(new TextDecoder().decode(bytes));

  return match ? Number(match[1]) : undefined;
}

function wantsReforged(buffer) {
  if (state.mode === 'tft') {
    return false;
  }

  if (state.mode === 'reforged') {
    return true;
  }

  const version = readModelVersion(buffer);

  return version !== undefined && version > 800;
}

// #endregion

// #region Model loading

async function loadModel(name, buffer, path, rebuild = false) {
  state.model = { name, path, buffer, dir: directoryOf(path || name) };
  state.missing = [];

  const reforged = wantsReforged(buffer);

  // A rebuild replaces the whole scene, and with it whatever was loaded before.
  if (rebuild || !state.viewer || state.viewerReforged !== reforged) {
    if (!createViewer(reforged)) {
      return;
    }
  }

  log(`加载模型 ${name}`, 'info');
  updateStatus();

  const model = await state.viewer.load(buffer, pathSolver);

  if (!model) {
    log(`模型加载失败: ${name}`, 'error');
    updateStatus();

    return;
  }

  const instance = model.addInstance();

  // Whatever was loaded before has to go, otherwise reloading just stacks models on top of
  // each other (the viewer itself is only rebuilt when the mode changes).
  if (state.instance) {
    state.scene.clearEmittedObjects();
    state.scene.removeInstance(state.instance);
  }

  instance.setScene(state.scene);
  instance.setSequenceLoopMode(2);

  if (model.sequences.length) {
    instance.setSequence(0);
  }

  state.instance = instance;

  ui.modelInfo.className = 'item';
  ui.modelInfo.textContent = `${name} · 动画 ${model.sequences.length} · 纹理 ${model.textures.length} · ${reforged ? 'Reforged' : 'TFT'}`;

  fitCamera(model);
  renderSequences(model);
  updateStatus();
}

function fitCamera(model) {
  const camera = state.camera;
  const bounds = model.bounds;
  const r = Math.max(bounds.r, 64);

  camera.target[0] = bounds.x;
  camera.target[1] = bounds.y;
  camera.target[2] = bounds.z;

  camera.moveToAndFace(
    [bounds.x + r * 0.9, bounds.y + r * 0.8, bounds.z + r * 1.8],
    [bounds.x, bounds.y, bounds.z]
  );
}

function reloadModel() {
  if (!state.model) {
    log('还没有加载模型', 'warn');

    return;
  }

  ui.reloadButton.classList.remove('attention');

  loadModel(state.model.name, state.model.buffer, state.model.path, true);
}

function hintReload() {
  if (state.model) {
    ui.reloadButton.classList.add('attention');
    log('来源已改变，点击「重新加载」以重新解析纹理', 'info');
  }
}

// #endregion

// #region Model UI

function renderSequences(model) {
  const select = ui.sequenceSelect;

  select.textContent = '';

  if (!model.sequences.length) {
    select.disabled = true;

    return;
  }

  select.disabled = false;

  for (let i = 0; i < model.sequences.length; i++) {
    const sequence = model.sequences[i];
    const option = document.createElement('option');

    option.value = `${i}`;
    option.textContent = sequence.name === '' ? `#${i}` : sequence.name;

    select.appendChild(option);
  }
}

function renderTeamColors() {
  const reforged = state.viewerReforged === true;
  const count = reforged ? 28 : 16;
  const select = ui.teamColorSelect;
  const selected = select.selectedIndex;

  select.textContent = '';

  for (let i = 0; i < count; i++) {
    const option = document.createElement('option');

    option.value = `${i}`;
    option.textContent = `队伍颜色 ${i}`;

    select.appendChild(option);
  }

  if (selected > 0 && selected < count) {
    select.selectedIndex = selected;
  }
}

// #endregion

// #region Dropped files

function addDroppedFiles(entries) {
  let added = 0;

  for (const entry of entries) {
    const path = normalizePath(entry.path);

    if (path === '' || state.dropped.some((item) => item.path === path)) {
      continue;
    }

    state.dropped.push({ path, file: entry.file });
    added++;
  }

  if (added === 0) {
    return;
  }

  state.droppedSource = null;

  log(`加入 ${added} 个本地文件`, 'info');
  renderDropped();
  updateStatus();
}

function walkedEntry(entry, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => {
        out.push({ path: entry.fullPath, file });
        resolve();
      }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();

      // readEntries() returns at most 100 entries per call, so it has to be called until empty.
      const readBatch = () => reader.readEntries(async (batch) => {
        if (batch.length === 0) {
          resolve();
          return;
        }

        await Promise.all(batch.map((child) => walkedEntry(child, out)));

        readBatch();
      }, () => resolve());

      readBatch();
    } else {
      resolve();
    }
  });
}

async function collectDroppedFiles(dataTransfer) {
  const entries = [];
  const items = dataTransfer.items;

  if (items && items.length && items[0].webkitGetAsEntry) {
    const promises = [];

    for (const item of items) {
      const entry = item.webkitGetAsEntry();

      if (entry) {
        promises.push(walkedEntry(entry, entries));
      }
    }

    await Promise.all(promises);
  }

  // Dropping files from outside a browser with directory support, or a dataTransfer that yields
  // no entries - the files are all there is, without relative paths.
  if (entries.length === 0) {
    for (const file of dataTransfer.files) {
      entries.push({ path: file.name, file });
    }
  }

  return entries;
}

async function onDrop(event) {
  event.preventDefault();

  setDragging(false);

  if (!event.dataTransfer) {
    return;
  }

  const entries = await collectDroppedFiles(event.dataTransfer);

  if (!entries.length) {
    return;
  }

  addDroppedFiles(entries);
  loadFirstDroppedModel();
}

/**
 * Loads the first model among the dropped files.
 *
 * Dropping a folder with several models in it loads one of them, and the rest stay listed in the
 * panel, where they can be clicked to load.
 */
function loadFirstDroppedModel() {
  const model = state.dropped.find((entry) => MODEL_EXTENSIONS.test(entry.path));

  if (model) {
    loadDroppedModel(model);
  } else {
    log('没有发现 .mdx / .mdl 文件，文件已加入来源，可继续拖入模型', 'warn');
  }
}

async function loadDroppedModel(entry) {
  const buffer = await entry.file.arrayBuffer();

  loadModel(entry.file.name, buffer, entry.path);
}

function renderDropped() {
  const list = ui.droppedList;

  list.textContent = '';
  ui.droppedCount.textContent = state.dropped.length === 0 ? '无' : `${state.dropped.length} 个文件`;

  const models = state.dropped.filter((entry) => MODEL_EXTENSIONS.test(entry.path));

  for (const entry of models.slice(0, 100)) {
    const row = document.createElement('div');

    row.className = 'item clickable';
    row.textContent = entry.path;
    row.title = '点击加载';
    row.addEventListener('click', () => loadDroppedModel(entry));

    if (state.model && state.model.path === entry.path) {
      row.classList.add('current');
    }

    list.appendChild(row);
  }

  if (models.length > 100) {
    const row = document.createElement('div');

    row.className = 'item muted';
    row.textContent = `...还有 ${models.length - 100} 个模型`;

    list.appendChild(row);
  }
}

// #endregion

// #region Sources UI

function renderSources() {
  renderDropped();
  renderTextures();
  renderMpq();
  updateStatus();
}

function renderTextures() {
  const list = ui.textureList;

  list.textContent = '';

  if (!state.textures.length) {
    const row = document.createElement('div');

    row.className = 'item muted';
    row.textContent = '无（优先级高于 MPQ，低于拖入的文件）';

    list.appendChild(row);

    return;
  }

  for (let i = 0; i < state.textures.length; i++) {
    const source = state.textures[i];
    const row = document.createElement('div');

    row.className = 'item';

    const label = document.createElement('span');

    label.className = 'grow';
    label.textContent = `${i + 1}. ${source.name} (${source.count} 个文件)`;

    row.appendChild(label);

    row.appendChild(button('↑', i === 0, () => {
      moveTexture(i, -1);
    }));

    row.appendChild(button('↓', i === state.textures.length - 1, () => {
      moveTexture(i, 1);
    }));

    row.appendChild(button('✕', false, () => {
      state.textures.splice(i, 1);
      log(`移除纹理目录 ${source.name}`, 'info');
      renderSources();
      hintReload();
    }));

    list.appendChild(row);
  }
}

function moveTexture(index, offset) {
  const target = index + offset;

  if (target < 0 || target >= state.textures.length) {
    return;
  }

  const [source] = state.textures.splice(index, 1);

  state.textures.splice(target, 0, source);

  renderSources();
  hintReload();
}

function renderMpq() {
  const list = ui.mpqList;
  const entries = state.mpq.archives.slice().sort((a, b) => a.rank - b.rank || a.order - b.order);

  list.textContent = '';

  if (!entries.length) {
    const row = document.createElement('div');

    row.className = 'item muted';
    row.textContent = '无（最低优先级）';

    list.appendChild(row);
    ui.mpqSummary.textContent = '';

    return;
  }

  const size = entries.reduce((total, entry) => total + entry.size, 0);

  ui.mpqSummary.textContent = `${entries.length} 个归档，共 ${formatSize(size)}；已解析 ${state.mpq.loadedCount()} 个`;

  for (const entry of entries) {
    const row = document.createElement('div');
    const checkbox = document.createElement('input');

    row.className = 'item';

    checkbox.type = 'checkbox';
    checkbox.checked = entry.enabled;
    checkbox.addEventListener('change', () => {
      entry.enabled = checkbox.checked;
      hintReload();
      renderMpq();
    });

    row.appendChild(checkbox);

    const label = document.createElement('span');

    label.className = 'grow';
    label.textContent = `${entry.name} (${formatSize(entry.size)})`;
    label.title = entry.path;

    row.appendChild(label);

    const status = document.createElement('span');

    status.className = `state ${entry.status}`;
    status.textContent = { idle: '未加载', loading: '加载中', ready: '就绪', error: '失败' }[entry.status];

    row.appendChild(status);

    row.appendChild(button('✕', false, () => {
      state.mpq.remove(entry);
      renderSources();
      hintReload();
    }));

    list.appendChild(row);
  }
}

function button(text, disabled, onclick) {
  const element = document.createElement('button');

  element.className = 'mini';
  element.textContent = text;
  element.disabled = disabled;
  element.addEventListener('click', onclick);

  return element;
}

// #endregion

// #region Picking directories and files

function pickGameDirectory() {
  const files = Array.from(ui.gameInput.files || []);
  const found = [];

  for (const file of files) {
    const relative = file.webkitRelativePath || file.name;
    const inner = relative.split('/').slice(1).join('/');

    // Only archives at the root of the game directory, plus anything named war3*.mpq.
    if (!/\.mpq$/i.test(file.name) || (inner.includes('/') && !/^war3/i.test(file.name))) {
      continue;
    }

    found.push({ file, relative });
  }

  if (!found.length) {
    log('这个目录里没有 MPQ 归档。1.30 及以后的安装使用 CASC 格式，本客户端不支持；请改用 1.27 或更早的经典安装目录，或直接拖入模型和纹理目录。', 'warn');

    return;
  }

  for (const item of found) {
    state.mpq.addFile(item.file, item.relative);
  }

  ui.gameDirName.textContent = found[0].relative.split('/')[0] || '游戏目录';

  log(`从游戏目录加入 ${found.length} 个 MPQ 归档`, 'info');
  renderSources();
  hintReload();
}

function pickTextureDirectory() {
  const files = Array.from(ui.textureInput.files || []);

  if (!files.length) {
    return;
  }

  const root = (files[0].webkitRelativePath || '').split('/')[0] || `纹理目录 ${state.textures.length + 1}`;
  const source = createFileSource(root, files.map(fileEntry));

  state.textures.push(source);

  log(`添加纹理目录 ${root} (${files.length} 个文件)`, 'info');
  renderSources();
  hintReload();
}

function pickMpqFiles() {
  const files = Array.from(ui.mpqInput.files || []);

  for (const file of files) {
    state.mpq.addFile(file);
  }

  if (files.length) {
    log(`手动加入 ${files.length} 个 MPQ 归档`, 'info');
    renderSources();
    hintReload();
  }
}

function pickModelFiles() {
  const files = Array.from(ui.modelInput.files || []);

  if (!files.length) {
    return;
  }

  addDroppedFiles(files.map((file) => ({ path: file.name, file })));
  loadFirstDroppedModel();
}

// #endregion

// #region Drag and drop

let dragDepth = 0;

function setDragging(dragging) {
  ui.overlay.classList.toggle('visible', dragging);
}

function installDragAndDrop() {
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    setDragging(true);
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);

    if (dragDepth === 0) {
      setDragging(false);
    }
  });

  window.addEventListener('drop', (e) => {
    dragDepth = 0;
    onDrop(e);
  });
}

// #endregion

// #region Wiring

function installUi() {
  ui.canvas = document.getElementById('canvas');
  ui.overlay = document.getElementById('overlay');
  ui.status = document.getElementById('status');
  ui.log = document.getElementById('log');
  ui.modelInfo = document.getElementById('modelInfo');
  ui.sequenceSelect = document.getElementById('sequenceSelect');
  ui.teamColorSelect = document.getElementById('teamColorSelect');
  ui.playButton = document.getElementById('playButton');
  ui.reloadButton = document.getElementById('reloadButton');
  ui.modeSelect = document.getElementById('modeSelect');
  ui.droppedCount = document.getElementById('droppedCount');
  ui.droppedList = document.getElementById('droppedList');
  ui.textureList = document.getElementById('textureList');
  ui.mpqList = document.getElementById('mpqList');
  ui.mpqSummary = document.getElementById('mpqSummary');
  ui.gameDirName = document.getElementById('gameDirName');
  ui.gameInput = document.getElementById('gameInput');
  ui.textureInput = document.getElementById('textureInput');
  ui.mpqInput = document.getElementById('mpqInput');
  ui.modelInput = document.getElementById('modelInput');

  document.getElementById('modelButton').addEventListener('click', () => ui.modelInput.click());
  document.getElementById('textureButton').addEventListener('click', () => ui.textureInput.click());
  document.getElementById('gameButton').addEventListener('click', () => ui.gameInput.click());
  document.getElementById('mpqButton').addEventListener('click', () => ui.mpqInput.click());
  document.getElementById('clearLog').addEventListener('click', () => {
    ui.log.textContent = '';
  });
  document.getElementById('clearDropped').addEventListener('click', () => {
    state.dropped = [];
    state.droppedSource = null;
    renderSources();
    hintReload();
  });
  document.getElementById('clearTextures').addEventListener('click', () => {
    state.textures = [];
    renderSources();
    hintReload();
  });

  ui.modelInput.addEventListener('change', pickModelFiles);
  ui.textureInput.addEventListener('change', pickTextureDirectory);
  ui.gameInput.addEventListener('change', pickGameDirectory);
  ui.mpqInput.addEventListener('change', pickMpqFiles);

  ui.reloadButton.addEventListener('click', reloadModel);

  ui.playButton.addEventListener('click', () => {
    state.playing = !state.playing;
    ui.playButton.textContent = state.playing ? '暂停' : '播放';
  });

  ui.sequenceSelect.addEventListener('change', () => {
    if (state.instance) {
      state.instance.setSequence(Number(ui.sequenceSelect.value));
      updateStatus();
    }
  });

  ui.teamColorSelect.addEventListener('change', () => {
    if (state.instance) {
      state.instance.setTeamColor(Number(ui.teamColorSelect.value));
    }
  });

  ui.modeSelect.addEventListener('change', () => {
    state.mode = ui.modeSelect.value;

    if (state.model) {
      log('模式已改变，点击「重新加载」以应用', 'info');
      hintReload();
    }
  });

  // Hidden inputs, used to pick the game directory and the extra texture directories.
  ui.gameInput.setAttribute('webkitdirectory', '');
  ui.textureInput.setAttribute('webkitdirectory', '');

  installDragAndDrop();
  renderSources();
  renderTeamColors();
}

// #endregion

(function main() {
  installUi();

  // Handy in the devtools console: window.localAssets gives access to the viewer, the camera,
  // the sources and the loaded model.
  window.localAssets = state;

  let last = performance.now();

  (function step() {
    requestAnimationFrame(step);

    const now = performance.now();
    const dt = state.playing ? now - last : 0;

    last = now;

    if (state.viewer) {
      state.viewer.updateAndRender(dt);
    }

    state.frames++;

    if (now - state.fpsTime >= 500) {
      state.fps = Math.round((state.frames * 1000) / (now - state.fpsTime));
      state.frames = 0;
      state.fpsTime = now;
      updateStatus();
    }
  }());
}());
