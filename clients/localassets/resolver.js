/**
 * Path resolution for the local assets client.
 *
 * A model asks for its files by the paths stored in it, such as "Textures\\Foo.blp".
 * Those paths have nothing to do with wherever the files actually are, so this module turns
 * a request into an ordered list of candidate names, and resolves them against ordered sources:
 *
 *   1) Files dropped into the page (highest priority).
 *   2) Extra texture directories, in the order the user arranged them.
 *   3) MPQ archives from the game directory (lowest priority).
 *
 * The module is deliberately free of DOM and viewer dependencies, so it can be tested in Node.
 */

import { basename, extname } from '../../src/common/path';

/**
 * The extensions a texture reference can be swapped with.
 *
 * SD Warcraft 3 uses BLP, Reforged uses DDS, and loose assets are often TGA/PNG.
 */
export const TEXTURE_EXTENSIONS = ['.blp', '.dds', '.tga', '.png', '.jpg', '.jpeg', '.gif', '.webp'];

/**
 * Normalizes a path to the form every index uses: lowercase, forward slashes, no leading
 * slash, and no leading "./".
 */
export function normalizePath(path) {
  if (typeof path !== 'string') {
    return '';
  }

  let result = path.trim().replace(/\\/g, '/').toLowerCase();

  while (result.startsWith('./')) {
    result = result.slice(2);
  }

  return result.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}

/**
 * Normalizes a directory path, keeping exactly one trailing slash.
 */
export function normalizeDirectory(path) {
  const result = normalizePath(path);

  if (result === '') {
    return '';
  }

  return result.endsWith('/') ? result : `${result}/`;
}

/**
 * The directory part of a path, as a normalized directory.
 *
 * "units/human/footman/footman.mdx" => "units/human/footman/"
 */
export function directoryOf(path) {
  const result = normalizePath(path);
  const index = result.lastIndexOf('/');

  return index === -1 ? '' : result.slice(0, index + 1);
}

/**
 * The given path, followed by the same path with every other known extension.
 * A path with no extension gets every extension appended.
 *
 * "textures/foo.blp" => ["textures/foo.blp", "textures/foo.dds", ...]
 */
export function extensionVariants(path) {
  const name = basename(path);
  const extension = extname(name);
  const prefix = path.slice(0, path.length - name.length);
  const stem = extension === '' ? name : name.slice(0, -extension.length);
  const variants = [path];

  for (const candidate of TEXTURE_EXTENSIONS) {
    if (candidate !== extension) {
      variants.push(`${prefix}${stem}${candidate}`);
    }
  }

  return variants;
}

/**
 * Turns a request for a source into ordered candidates:
 *
 *   paths - full paths, relative to the model's own directory first (the model may have been
 *           dropped as part of a folder), then relative to the root of the source.
 *   names - bare file names, to be matched anywhere in the source.
 *
 * Every stage contains the extension variants of the request, so an existing ".blp" always
 * wins over a swapped ".dds".
 */
export function resolveCandidates(src, modelDir = '') {
  const path = normalizePath(src);
  const directory = normalizeDirectory(modelDir);
  const paths = [];
  const names = [];
  const seenPaths = new Set();
  const seenNames = new Set();

  const add = (list, seen, candidate) => {
    const normalized = normalizePath(candidate);

    if (normalized !== '' && !seen.has(normalized)) {
      seen.add(normalized);
      list.push(normalized);
    }
  };

  const variants = extensionVariants(path);
  const exact = variants[0];
  const swapped = variants.slice(1);

  // Exact full paths - relative to the model's own directory first, then to the source root.
  if (directory !== '') {
    add(paths, seenPaths, directory + exact);
  }

  add(paths, seenPaths, exact);

  // The same paths with a swapped extension, so that an existing file always wins over a guess.
  for (const variant of swapped) {
    if (directory !== '') {
      add(paths, seenPaths, directory + variant);
    }
  }

  for (const variant of swapped) {
    add(paths, seenPaths, variant);
  }

  // Bare file names, to be matched anywhere in the source.
  // These live in a separate namespace, so they get their own dedupe set.
  for (const variant of extensionVariants(basename(path))) {
    add(names, seenNames, variant);
  }

  return { paths, names };
}

/**
 * Creates a source backed by a flat list of files.
 *
 * Every entry is `{path, read}`, where `path` is relative to the source's root, and `read`
 * returns the file's data, either directly or as a promise.
 */
export function createFileSource(name, entries, options = {}) {
  const byPath = new Map();
  const byName = new Map();

  for (const entry of entries) {
    const path = normalizePath(entry.path);

    if (path === '') {
      continue;
    }

    const normalized = { path, read: entry.read };

    if (!byPath.has(path)) {
      byPath.set(path, normalized);
    }

    const base = basename(path);
    const list = byName.get(base);

    if (list) {
      list.push(normalized);
    } else {
      byName.set(base, [normalized]);
    }
  }

  return {
    name,
    kind: options.kind || 'files',
    /**
     * MPQ paths are archive-global, so the model's own directory doesn't apply to them.
     */
    useModelDir: options.useModelDir !== false,
    count: byPath.size,
    async get(src, modelDir) {
      const { paths, names } = resolveCandidates(src, this.useModelDir ? modelDir : '');
      const wanted = normalizePath(src);

      for (const candidate of paths) {
        const entry = byPath.get(candidate);

        if (entry) {
          return { path: entry.path, source: this.name, data: await entry.read() };
        }
      }

      for (const candidate of names) {
        const list = byName.get(candidate);

        if (!list) {
          continue;
        }

        // Prefer a file whose path ends with whatever was asked for, so that a request for
        // "foo.blp" doesn't resolve to the first unrelated "foo.blp" in the source.
        const entry = list.find((item) => item.path === wanted || item.path.endsWith(`/${wanted}`)) || list[0];

        return { path: entry.path, source: this.name, data: await entry.read() };
      }

      return undefined;
    },
  };
}

/**
 * Walks the given sources in priority order, and returns the first match, if any.
 *
 * The result is `{path, source, data}`, where `source` is the name of the source that matched.
 */
export async function resolveFromSources(sources, src, modelDir, onEvent) {
  for (const source of sources) {
    const hit = await source.get(src, modelDir, onEvent);

    if (hit) {
      return hit;
    }
  }

  return undefined;
}
