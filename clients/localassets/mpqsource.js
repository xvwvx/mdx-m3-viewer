/**
 * The MPQ tier of the local assets client - the lowest priority source.
 *
 * Archives are added as files (from a game directory pick, or picked manually), and are only
 * parsed when something is actually looked up, in archive priority order.
 *
 * Note that the MPQ parser needs the whole archive in memory to decode files from it, so a full
 * classic install (War3.mpq + War3x.mpq + the local/patch archives) can take well over a GB.
 * Only the archives that are actually needed for the current model get loaded.
 */

import MpqArchive from '../../src/parsers/mpq/archive';
import { basename } from '../../src/common/path';
import { resolveCandidates } from './resolver';

/**
 * Lookup order within the MPQ tier.
 *
 * Patches override the base archives, localized archives override their non-localized
 * counterparts, and War3.mpq (RoC) is the base that everything else sits on top of.
 */
const ARCHIVE_PRIORITY = [
  'war3patch.mpq',
  'war3xlocal.mpq',
  'war3local.mpq',
  'war3x.mpq',
  'war3.mpq',
];

/**
 * Files loaded from an archive with no resolved name get a name like "File00000012".
 */
const UNRESOLVED_NAME = /^File\d{8}$/;

/**
 * Finds an archive's place in the priority order, with unknown archives last.
 */
export function archiveRank(path) {
  const index = ARCHIVE_PRIORITY.indexOf(basename(path).toLowerCase());

  return index === -1 ? ARCHIVE_PRIORITY.length : index;
}

/**
 * MPQ names use backslashes, and the hash ignores case but does not normalize separators.
 */
function toMpqName(path) {
  return path.replace(/\//g, '\\');
}

/**
 * Formats a byte count for the UI.
 */
export function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function createMpqSource(name = 'MPQ') {
  const archives = [];
  let order = 0;

  /**
   * The enabled archives, in priority order.
   */
  function enabled() {
    return archives
      .filter((entry) => entry.enabled)
      .sort((a, b) => a.rank - b.rank || a.order - b.order);
  }

  /**
   * An index of the archive's resolved file names, keyed by bare file name.
   * Only possible when the archive has a (listfile), and only built when it's needed.
   */
  function nameIndex(entry) {
    if (entry.names === null) {
      const names = new Map();

      for (const archiveName of entry.archive.getFileNames()) {
        if (UNRESOLVED_NAME.test(archiveName)) {
          continue;
        }

        const base = basename(archiveName).toLowerCase();
        const list = names.get(base);

        if (list) {
          list.push(archiveName);
        } else {
          names.set(base, [archiveName]);
        }
      }

      entry.names = names;
    }

    return entry.names;
  }

  /**
   * Parses the archive if it wasn't parsed yet.
   *
   * Everything here is synchronous and can take a few seconds for a big archive, so the fetching
   * of the file is async, and a timeout is used to give the UI a chance to show the progress.
   */
  async function ensureLoaded(entry, onEvent) {
    if (entry.status === 'loading') {
      return entry.promise;
    }

    if (entry.status !== 'idle') {
      return;
    }

    entry.status = 'loading';
    entry.promise = (async () => {
      try {
        if (onEvent) {
          onEvent(`读取归档 ${entry.name} (${formatSize(entry.size)})`);
        }

        const buffer = await entry.file.arrayBuffer();

        if (onEvent) {
          onEvent(`解析归档 ${entry.name} (${formatSize(entry.size)})`);
        }

        await new Promise((resolve) => setTimeout(resolve, 20));

        const archive = new MpqArchive();

        archive.load(buffer, true);

        entry.archive = archive;
        entry.status = 'ready';

        if (onEvent) {
          onEvent(`归档就绪 ${entry.name} (${archive.files.length} 个文件)`);
        }
      } catch (e) {
        entry.status = 'error';
        entry.error = e;

        if (onEvent) {
          onEvent(`归档 ${entry.name} 解析失败: ${e.message || e}`, 'error');
        }
      } finally {
        entry.promise = null;
      }
    })();

    return entry.promise;
  }

  return {
    name,
    kind: 'mpq',
    useModelDir: false,
    archives,
    get count() {
      return archives.length;
    },
    /**
     * The archives that are parsed and usable.
     */
    loadedCount() {
      return archives.filter((entry) => entry.status === 'ready').length;
    },
    enabled,
    /**
     * Adds a File (a picked *.mpq, or one found in a picked game directory).
     * Files that are already in the source are ignored.
     */
    addFile(file, relativePath) {
      const path = relativePath || file.webkitRelativePath || file.name;

      if (archives.some((entry) => entry.path === path && entry.size === file.size)) {
        return undefined;
      }

      const entry = {
        name: file.name,
        path,
        size: file.size,
        file,
        rank: archiveRank(file.name),
        order: order++,
        enabled: true,
        status: 'idle',
        error: null,
        archive: null,
        names: null,
        promise: null,
      };

      archives.push(entry);

      return entry;
    },
    remove(entry) {
      const index = archives.indexOf(entry);

      if (index !== -1) {
        archives.splice(index, 1);
      }
    },
    /**
     * Looks a path up in every enabled archive, in archive priority order.
     *
     * Full paths are tried before bare file names, so an exact match always wins over a
     * swapped-extension guess.
     */
    async get(src, modelDir, onEvent) {
      const list = enabled();

      if (list.length === 0) {
        return undefined;
      }

      const { paths, names } = resolveCandidates(src, '');

      for (const candidate of paths) {
        for (const entry of list) {
          await ensureLoaded(entry, onEvent);

          if (entry.status !== 'ready') {
            continue;
          }

          const file = entry.archive.get(toMpqName(candidate)) || entry.archive.get(candidate);

          if (file) {
            return { path: candidate, source: `${this.name}:${entry.name}`, data: file.bytes() };
          }
        }
      }

      // Last resort - any file in an archive with a matching name. This needs the archive's
      // (listfile), so it's skipped when the archive has nothing resolved.
      for (const candidate of names) {
        for (const entry of list) {
          if (entry.status !== 'ready' || !entry.archive.has('(listfile)')) {
            continue;
          }

          const found = nameIndex(entry).get(candidate);

          if (!found || found.length === 0) {
            continue;
          }

          const suffix = `\\${candidate}`;
          const best = found.find((item) => toMpqName(item).toLowerCase().endsWith(suffix)) || found[0];
          const file = entry.archive.get(best);

          if (file) {
            return { path: best, source: `${this.name}:${entry.name}`, data: file.bytes() };
          }
        }
      }

      return undefined;
    },
  };
}
