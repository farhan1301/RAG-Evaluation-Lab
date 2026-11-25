import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from '@rag-eval/contracts';

const lockMetadataSchema = z.strictObject({
  pid: z.int().positive(),
  hostname: z.string().min(1),
  createdAt: z.iso.datetime(),
});

export const restoreSwapJournalSchema = z.strictObject({
  version: z.literal(1),
  stageId: z.string().min(1),
  phase: z.enum(['swapping', 'committed']),
  targetDbPath: z.string().min(1),
  targetBlobsDir: z.string().min(1),
  stagedDbPath: z.string().min(1),
  stagedBlobsDir: z.string().min(1),
  prevDbPath: z.string().min(1),
  prevWalPath: z.string().min(1),
  prevShmPath: z.string().min(1),
  prevBlobsDir: z.string().min(1),
  hadPrevDb: z.boolean(),
  hadPrevWal: z.boolean(),
  hadPrevShm: z.boolean(),
  hadPrevBlobs: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type RestoreSwapJournal = z.infer<typeof restoreSwapJournalSchema>;

function canonicalize(targetPath: string): string {
  let current = resolve(targetPath);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  if (existsSync(current)) {
    try {
      current = realpathSync(current);
    } catch {
      // Keep resolved path when canonicalization is unavailable.
    }
  }
  return tail.length ? join(current, ...tail) : current;
}

export function restoreJournalPath(databasePath: string): string {
  return `${canonicalize(databasePath)}.restore-journal.json`;
}

export function restoreLockPathForDb(databasePath: string): string {
  return `${canonicalize(databasePath)}.rag-eval-restore.lock`;
}

export function restoreLockPathForBlobs(blobDirectory: string): string {
  const abs = canonicalize(blobDirectory);
  return join(dirname(abs), `.${basename(abs)}.rag-eval-restore.lock`);
}

export function backupLockPath(outputDir: string): string {
  const abs = canonicalize(outputDir);
  return join(dirname(abs), `.${basename(abs)}.rag-eval-backup.lock`);
}

function isProcessDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function isStaleLockMetadata(raw: string): boolean {
  try {
    const parsed = lockMetadataSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return false;
    if (parsed.data.hostname !== hostname()) return false;
    if (parsed.data.pid === process.pid) return false;
    return isProcessDefinitelyDead(parsed.data.pid);
  } catch {
    return false;
  }
}

function lockPayload(): string {
  return `${JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  })}\n`;
}

async function acquireLockAsync(
  lockPath: string,
  timeoutMs: number,
  pollMs: number,
): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(lockPayload(), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = await readFile(lockPath, 'utf8').catch(() => '');
      if (existing && isStaleLockMetadata(existing)) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for exclusive operation lock: ${lockPath}`,
        );
      }
      await wait(pollMs);
    }
  }
}

/**
 * Serializes backup or restore operations targeting the same filesystem paths
 * using exclusive (`O_CREAT | O_EXCL`) lock files acquired in sorted order.
 */
export async function withExclusiveLocks<T>(
  lockPaths: string[],
  work: () => Promise<T>,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 20;
  const uniqueSorted = Array.from(
    new Set(lockPaths.map((p) => resolve(p))),
  ).sort();
  const acquired: string[] = [];

  try {
    for (const lockPath of uniqueSorted) {
      await acquireLockAsync(lockPath, timeoutMs, pollMs);
      acquired.push(lockPath);
    }
    return await work();
  } finally {
    for (let i = acquired.length - 1; i >= 0; i--) {
      await unlink(acquired[i]).catch(() => {});
    }
  }
}

/**
 * Atomically persists a restore swap journal next to the target SQLite database
 * so an interrupted swap can be durably rolled back or completed on next restore
 * or workspace startup.
 */
export async function writeRestoreJournal(
  journal: RestoreSwapJournal,
): Promise<void> {
  const validated = restoreSwapJournalSchema.parse(journal);
  const path = restoreJournalPath(validated.targetDbPath);
  const tmpPath = `${path}.tmp-${validated.stageId}`;
  const handle = await open(tmpPath, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, path);
}

export async function removeRestoreJournal(
  databasePath: string,
): Promise<void> {
  await rm(restoreJournalPath(databasePath), { force: true });
}

function acquireLockSyncForRecovery(lockPath: string): boolean {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(fd, lockPayload(), 'utf8');
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let existing = '';
      try {
        existing = readFileSync(lockPath, 'utf8');
      } catch {
        // Lock disappeared between open and read; retry once.
        continue;
      }
      if (existing && isStaleLockMetadata(existing)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Ignore race if already removed.
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

function removeDbSidecarsSync(dbPath: string): void {
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

function applyRestoreJournalSync(journal: RestoreSwapJournal): void {
  if (journal.phase === 'committed') {
    // Replacement workspace was already installed and verified; finish cleaning up previous backups.
    rmSync(journal.prevDbPath, { force: true });
    rmSync(journal.prevWalPath, { force: true });
    rmSync(journal.prevShmPath, { force: true });
    rmSync(journal.prevBlobsDir, { recursive: true, force: true });
    rmSync(journal.stagedDbPath, { force: true });
    removeDbSidecarsSync(journal.stagedDbPath);
    rmSync(journal.stagedBlobsDir, { recursive: true, force: true });
    return;
  }

  // phase === 'swapping': durably and idempotently roll back to the pre-restore workspace.
  const stagedDbMoved = !existsSync(journal.stagedDbPath);
  if (existsSync(journal.prevDbPath)) {
    rmSync(journal.targetDbPath, { force: true });
    removeDbSidecarsSync(journal.targetDbPath);
    renameSync(journal.prevDbPath, journal.targetDbPath);
  } else if (!journal.hadPrevDb && stagedDbMoved) {
    rmSync(journal.targetDbPath, { force: true });
    removeDbSidecarsSync(journal.targetDbPath);
  }

  const targetWal = `${journal.targetDbPath}-wal`;
  if (existsSync(journal.prevWalPath)) {
    rmSync(targetWal, { force: true });
    renameSync(journal.prevWalPath, targetWal);
  } else if (!journal.hadPrevWal && stagedDbMoved) {
    rmSync(targetWal, { force: true });
  }

  const targetShm = `${journal.targetDbPath}-shm`;
  if (existsSync(journal.prevShmPath)) {
    rmSync(targetShm, { force: true });
    renameSync(journal.prevShmPath, targetShm);
  } else if (!journal.hadPrevShm && stagedDbMoved) {
    rmSync(targetShm, { force: true });
  }

  const stagedBlobsMoved = !existsSync(journal.stagedBlobsDir);
  if (existsSync(journal.prevBlobsDir)) {
    rmSync(journal.targetBlobsDir, { recursive: true, force: true });
    renameSync(journal.prevBlobsDir, journal.targetBlobsDir);
  } else if (!journal.hadPrevBlobs && stagedBlobsMoved) {
    rmSync(journal.targetBlobsDir, { recursive: true, force: true });
  }

  rmSync(journal.stagedDbPath, { force: true });
  removeDbSidecarsSync(journal.stagedDbPath);
  rmSync(journal.stagedBlobsDir, { recursive: true, force: true });
}

/**
 * Checks for an interrupted restore swap journal next to `databasePath` and
 * either rolls back an uncommitted swap (`phase: 'swapping'`) or completes
 * cleanup for a verified swap (`phase: 'committed'`) before anything opens the DB.
 */
export function recoverInterruptedRestoreSync(
  databasePath: string,
  options: { alreadyLocked?: boolean } = {},
): boolean {
  if (databasePath === ':memory:') return false;
  const journalPath = restoreJournalPath(databasePath);
  if (!existsSync(journalPath)) return false;

  const lockPath = restoreLockPathForDb(databasePath);
  let acquiredLock = false;
  if (!options.alreadyLocked) {
    acquiredLock = acquireLockSyncForRecovery(lockPath);
    if (!acquiredLock) {
      throw new Error(
        `Cannot open SQLite database while a workspace restore is in progress: ${resolve(databasePath)}`,
      );
    }
  }

  try {
    if (!existsSync(journalPath)) return false;
    const raw = readFileSync(journalPath, 'utf8');
    const journal = restoreSwapJournalSchema.parse(JSON.parse(raw));
    applyRestoreJournalSync(journal);
    rmSync(journalPath, { force: true });
    return true;
  } finally {
    if (acquiredLock) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Ignore if already removed.
      }
    }
  }
}
