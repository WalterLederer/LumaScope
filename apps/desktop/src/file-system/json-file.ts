import { randomUUID } from 'node:crypto';
import { readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Serialize writes from the renderer config and startup-bounds persistence.
// Atomic replacement prevents readers from seeing a partially written JSON file.
const pendingWrites = new Map<string, Promise<void>>();

// Atomic writes normally finish in milliseconds. One minute is a generous
// grace period for a write that is still active when startup cleanup runs.
const staleTemporaryFileAgeMs = 60 * 1000;
const atomicJsonTemporaryFilePattern = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;

/**
 * Remove abandoned atomic-JSON write files from a directory.
 * Only matching UUID-named files older than one minute are eligible, so
 * active writes and unrelated application temporary files are never touched.
 */
export const cleanupStaleJsonTemporaryFiles = async (directory: string): Promise<number> => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }

  let removed = 0;
  const cutoff = Date.now() - staleTemporaryFileAgeMs;
  for (const entry of entries) {
    if (!entry.isFile() || !atomicJsonTemporaryFilePattern.test(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      const details = await stat(path);
      if (details.mtimeMs >= cutoff) continue;
      await unlink(path);
      removed++;
    } catch (error) {
      // A file may disappear or be locked between listing and deletion.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
        throw error;
      }
    }
  }
  return removed;
};

const renameWithRetry = async (source: string, destination: string): Promise<void> => {
  const retryableCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!retryableCodes.has(code ?? '') || attempt >= 5) throw error;
      // Windows file scanners and short-lived readers can briefly prevent
      // replacing the settings file. Retry without deleting the last good copy.
      await new Promise(resolve => setTimeout(resolve, 50 * (2 ** attempt)));
    }
  }
};

const writeJsonAtomicallyUnlocked = async (filePath: string, data: unknown): Promise<void> => {
  const temporaryPath = join(dirname(filePath), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, JSON.stringify(data, null, 2), 'utf-8');
    await renameWithRetry(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

/**
 * Run a complete read/backup/update/write transaction under the same per-file
 * queue used by all atomic JSON writes. The supplied writer is valid only
 * inside the transaction and deliberately does not acquire the lock again.
 */
export const withJsonFileTransaction = async <T>(
  filePath: string,
  transaction: (write: (data: unknown) => Promise<void>) => Promise<T>
): Promise<T> => {
  const previous = pendingWrites.get(filePath) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() =>
    transaction(data => writeJsonAtomicallyUnlocked(filePath, data))
  );
  const queuedOperation = operation.then(() => undefined);
  pendingWrites.set(filePath, queuedOperation);
  try {
    return await operation;
  } finally {
    if (pendingWrites.get(filePath) === queuedOperation) {
      pendingWrites.delete(filePath);
    }
  }
};

export const writeJsonAtomically = async (filePath: string, data: unknown): Promise<void> =>
  withJsonFileTransaction(filePath, write => write(data));
