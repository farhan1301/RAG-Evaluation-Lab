import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, type Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import * as sqlite from 'node:sqlite';
import { z } from '@rag-eval/contracts';
import { isValidBlobKey } from '../ingestion/blobs.js';
import {
  integrityCheck,
  openDatabase,
  ready,
  SCHEMA_VERSION,
} from './database.js';
import {
  backupLockPath,
  recoverInterruptedRestoreSync,
  removeRestoreJournal,
  restoreLockPathForBlobs,
  restoreLockPathForDb,
  withExclusiveLocks,
  writeRestoreJournal,
  type RestoreSwapJournal,
} from './restoreJournal.js';
import { SOFTWARE_VERSION } from './runs.js';

const backupBlobEntry = z.strictObject({
  bytes: z.int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const backupManifestSchema = z.strictObject({
  formatVersion: z.literal(1),
  softwareVersion: z.string().min(1),
  schemaVersion: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
  sqliteFile: z.literal('workspace.sqlite'),
  sqliteBytes: z.int().positive(),
  sqliteSha256: z.string().regex(/^[a-f0-9]{64}$/),
  blobCount: z.int().nonnegative(),
  blobs: z.record(z.string(), backupBlobEntry),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export interface BackupOptions {
  databasePath: string;
  blobDirectory: string;
  outputDir: string;
  overwrite?: boolean;
  now?: () => number;
}

export interface RestoreOptions {
  backupDir: string;
  databasePath: string;
  blobDirectory: string;
  force?: boolean;
}

export interface RestoreResult {
  manifest: BackupManifest;
  databasePath: string;
  blobDirectory: string;
  restoredBlobs: number;
}

async function sha256File(filePath: string): Promise<{
  bytes: number;
  sha256: string;
}> {
  const data = await readFile(filePath);
  return {
    bytes: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

interface ExpectedBlob {
  bytes: number;
  sha256: string;
}

export function canonicalPath(targetPath: string): string {
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

function isSameOrInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('../');
}

export function pathsOverlap(a: string, b: string): boolean {
  const ca = canonicalPath(a);
  const cb = canonicalPath(b);
  return isSameOrInside(ca, cb) || isSameOrInside(cb, ca);
}

function assertNoOverlap(
  leftPaths: string[],
  rightPaths: string[],
  message: string,
): void {
  for (const left of leftPaths) {
    for (const right of rightPaths) {
      if (pathsOverlap(left, right)) {
        throw new Error(message);
      }
    }
  }
}

function extractSqliteBlobRefs(
  db: sqlite.DatabaseSync,
): Map<string, ExpectedBlob> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_versions'",
    )
    .all();
  if (tables.length === 0) return new Map();

  const columns = new Set(
    (
      db.prepare('PRAGMA table_info(document_versions)').all() as Array<{
        name?: unknown;
      }>
    ).map((col) => String(col.name ?? '')),
  );
  if (!columns.has('blob_key')) return new Map();

  const rows = db
    .prepare(
      'SELECT id, blob_key AS blobKey, hash, byte_size AS byteSize FROM document_versions WHERE blob_key IS NOT NULL',
    )
    .all() as Array<{
    id?: unknown;
    blobKey?: unknown;
    hash?: unknown;
    byteSize?: unknown;
  }>;

  const refs = new Map<string, ExpectedBlob>();
  for (const row of rows) {
    if (typeof row.blobKey !== 'string' || !isValidBlobKey(row.blobKey)) {
      throw new Error(
        `Unsafe or non-UUID blob key in SQLite document_versions (${String(row.id ?? 'unknown')}): ${String(row.blobKey)}`,
      );
    }
    if (typeof row.hash !== 'string' || !SHA256_HEX_PATTERN.test(row.hash)) {
      throw new Error(
        `Invalid SHA-256 hash in SQLite document_versions for blob ${row.blobKey}.`,
      );
    }
    if (
      typeof row.byteSize !== 'number' ||
      !Number.isSafeInteger(row.byteSize) ||
      row.byteSize < 0
    ) {
      throw new Error(
        `Invalid byte size in SQLite document_versions for blob ${row.blobKey}.`,
      );
    }
    const existing = refs.get(row.blobKey);
    if (
      existing &&
      (existing.bytes !== row.byteSize || existing.sha256 !== row.hash)
    ) {
      throw new Error(
        `Conflicting SQLite size/hash metadata for referenced blob key ${row.blobKey}.`,
      );
    }
    refs.set(row.blobKey, { bytes: row.byteSize, sha256: row.hash });
  }
  return refs;
}

async function verifyRegularBlobFile(
  blobsRoot: string,
  key: string,
  expected: ExpectedBlob,
): Promise<ExpectedBlob> {
  if (!isValidBlobKey(key)) {
    throw new Error(`Unsafe or non-UUID blob key: ${key}`);
  }
  let rootInfo: Stats;
  try {
    rootInfo = await stat(blobsRoot);
  } catch {
    throw new Error(`Blob directory not found: ${blobsRoot}`);
  }
  if (!rootInfo.isDirectory()) {
    throw new Error(`Blob path is not a directory: ${blobsRoot}`);
  }

  const blobPath = join(blobsRoot, key);
  let entryInfo: Stats;
  try {
    entryInfo = await lstat(blobPath);
  } catch {
    throw new Error(`Referenced blob file missing: ${key}`);
  }
  if (entryInfo.isSymbolicLink() || !entryInfo.isFile()) {
    throw new Error(
      `Referenced blob entry is not a regular file (symlinks are rejected): ${key}`,
    );
  }

  const [realRoot, realBlob] = await Promise.all([
    realpath(blobsRoot),
    realpath(blobPath),
  ]);
  if (dirname(realBlob) !== realRoot) {
    throw new Error(`Referenced blob file escapes blob root directory: ${key}`);
  }

  const actual = await sha256File(blobPath);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(
      `Blob size/checksum mismatch for ${key}: expected ${expected.bytes} bytes (${expected.sha256}), got ${actual.bytes} bytes (${actual.sha256}).`,
    );
  }
  return actual;
}

async function assertBackupDestinationWritable(
  outputDir: string,
  overwrite: boolean,
): Promise<void> {
  if (!existsSync(outputDir)) return;
  const outInfo = await lstat(outputDir);
  if (outInfo.isDirectory()) {
    const existing = await readdir(outputDir);
    if (existing.length > 0 && !overwrite) {
      throw new Error(
        `Backup destination already exists and is not empty: ${outputDir} (pass --overwrite to replace).`,
      );
    }
  } else if (!overwrite) {
    throw new Error(
      `Backup destination already exists: ${outputDir} (pass --overwrite to replace).`,
    );
  }
}

async function assertRestoreTargetsWritable(
  targetDbPath: string,
  targetBlobsDir: string,
  force: boolean,
): Promise<void> {
  if (force) return;
  if (existsSync(targetDbPath)) {
    throw new Error(
      `Target SQLite database already exists: ${targetDbPath}. Stop app/worker and re-run with --force to replace it.`,
    );
  }
  if (existsSync(targetBlobsDir)) {
    const targetBlobInfo = await lstat(targetBlobsDir);
    if (!targetBlobInfo.isDirectory()) {
      throw new Error(
        `Target blob path already exists: ${targetBlobsDir}. Stop app/worker and re-run with --force to replace it.`,
      );
    }
    const existingBlobs = await readdir(targetBlobsDir);
    if (existingBlobs.length > 0) {
      throw new Error(
        `Target blob directory already exists and is not empty: ${targetBlobsDir}. Stop app/worker and re-run with --force to replace it.`,
      );
    }
  }
}

/**
 * Creates a consistent online backup of the SQLite database (using node:sqlite's
 * online backup API, falling back to VACUUM INTO on older Node 22.13-22.15)
 * together with SQLite-referenced private blobs and a verified SHA-256 manifest.
 * Operations on the same output directory are serialized with an exclusive lock file.
 */
export async function backupWorkspace(
  options: BackupOptions,
): Promise<BackupManifest> {
  if (options.databasePath === ':memory:') {
    throw new Error('Cannot back up an in-memory SQLite database.');
  }
  const sourceDbPath = resolve(options.databasePath);
  const sourceBlobsDir = resolve(options.blobDirectory);
  const outputDir = resolve(options.outputDir);
  const overwrite = Boolean(options.overwrite);

  assertNoOverlap(
    [outputDir],
    [
      sourceDbPath,
      `${sourceDbPath}-wal`,
      `${sourceDbPath}-shm`,
      sourceBlobsDir,
    ],
    'Backup destination overlaps the source database or blob directory.',
  );

  if (!existsSync(sourceDbPath)) {
    throw new Error(`SQLite database not found: ${sourceDbPath}`);
  }

  await assertBackupDestinationWritable(outputDir, overwrite);

  const lockFile = backupLockPath(canonicalPath(outputDir));
  return withExclusiveLocks([lockFile], async () => {
    await assertBackupDestinationWritable(outputDir, overwrite);

    const outputParent = dirname(outputDir);
    await mkdir(outputParent, { recursive: true, mode: 0o700 });
    const stageId = randomUUID();
    const stageDir = join(outputParent, `.rag-eval-backup-stage-${stageId}`);
    const destBlobsDir = join(stageDir, 'blobs');

    try {
      await mkdir(destBlobsDir, { recursive: true, mode: 0o700 });

      const tempDbPath = join(stageDir, 'workspace.sqlite.tmp');
      const destDbPath = join(stageDir, 'workspace.sqlite');

      const sourceDb = new sqlite.DatabaseSync(sourceDbPath);
      try {
        sourceDb.exec('PRAGMA busy_timeout=5000');
        if (typeof sqlite.backup === 'function') {
          await sqlite.backup(sourceDb, tempDbPath);
        } else {
          sourceDb.prepare('VACUUM INTO ?').run(tempDbPath);
        }
      } finally {
        sourceDb.close();
      }

      let schemaVersion = 0;
      let referencedBlobs = new Map<string, ExpectedBlob>();
      const verifyDb = new sqlite.DatabaseSync(tempDbPath, { readOnly: true });
      try {
        if (!integrityCheck(verifyDb)) {
          throw new Error('SQLite backup failed PRAGMA integrity_check.');
        }
        schemaVersion = Number(
          verifyDb.prepare('PRAGMA user_version').get()?.user_version ?? 0,
        );
        referencedBlobs = extractSqliteBlobRefs(verifyDb);
      } finally {
        verifyDb.close();
      }

      await rename(tempDbPath, destDbPath);
      await chmod(destDbPath, 0o600);
      const sqliteMeta = await sha256File(destDbPath);

      const blobs: Record<string, { bytes: number; sha256: string }> = {};
      for (const [key, expected] of referencedBlobs) {
        await verifyRegularBlobFile(sourceBlobsDir, key, expected);
        const src = join(sourceBlobsDir, key);
        const dst = join(destBlobsDir, key);
        await copyFile(src, dst);
        await chmod(dst, 0o600);
        const copied = await sha256File(dst);
        if (
          copied.bytes !== expected.bytes ||
          copied.sha256 !== expected.sha256
        ) {
          throw new Error(`Copied backup blob checksum mismatch for ${key}.`);
        }
        blobs[key] = copied;
      }

      const manifest = backupManifestSchema.parse({
        formatVersion: 1,
        softwareVersion: SOFTWARE_VERSION,
        schemaVersion,
        createdAt: new Date((options.now ?? Date.now)()).toISOString(),
        sqliteFile: 'workspace.sqlite',
        sqliteBytes: sqliteMeta.bytes,
        sqliteSha256: sqliteMeta.sha256,
        blobCount: Object.keys(blobs).length,
        blobs,
      });

      const manifestTmp = join(stageDir, 'manifest.json.tmp');
      const manifestPath = join(stageDir, 'manifest.json');
      await writeFile(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(manifestTmp, manifestPath);

      // Re-verify overwrite permission under the lock immediately before swapping.
      await assertBackupDestinationWritable(outputDir, overwrite);

      let prevDir: string | null = null;
      if (existsSync(outputDir)) {
        prevDir = join(outputParent, `.rag-eval-backup-prev-${stageId}`);
        await rename(outputDir, prevDir);
      }
      try {
        await rename(stageDir, outputDir);
      } catch (swapErr) {
        if (prevDir) {
          await rename(prevDir, outputDir).catch(() => {});
        }
        throw swapErr;
      }
      if (prevDir) {
        await rm(prevDir, { recursive: true, force: true });
      }

      return manifest;
    } catch (err) {
      await rm(stageDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  });
}

/**
 * Verifies a backup directory against its manifest, SQLite snapshot references,
 * and integrity checks, then atomically stages and swaps the replacement
 * SQLite database and private blob directory without destroying the prior
 * workspace until the restored workspace is verified.
 */
export async function restoreWorkspace(
  options: RestoreOptions,
): Promise<RestoreResult> {
  if (options.databasePath === ':memory:') {
    throw new Error('Cannot restore into an in-memory SQLite database.');
  }
  const backupDir = resolve(options.backupDir);
  const targetDbPath = resolve(options.databasePath);
  const targetBlobsDir = resolve(options.blobDirectory);
  const targetDbPaths = [
    targetDbPath,
    `${targetDbPath}-wal`,
    `${targetDbPath}-shm`,
  ];

  assertNoOverlap(
    [backupDir],
    [...targetDbPaths, targetBlobsDir],
    'Restore paths must not overlap between backup source and restore destination.',
  );
  assertNoOverlap(
    targetDbPaths,
    [targetBlobsDir],
    'Target database path and target blob directory must not overlap.',
  );

  const manifestPath = join(backupDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Backup manifest not found: ${manifestPath}`);
  }
  const manifestInfo = await lstat(manifestPath);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
    throw new Error(`Backup manifest is not a regular file: ${manifestPath}`);
  }
  const manifest = backupManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, 'utf8')),
  );

  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `Backup schema version (${manifest.schemaVersion}) is newer than this application (${SCHEMA_VERSION}).`,
    );
  }

  const sourceSqlite = join(backupDir, manifest.sqliteFile);
  if (!existsSync(sourceSqlite)) {
    throw new Error(`Backup SQLite file missing: ${sourceSqlite}`);
  }
  const sqliteInfo = await lstat(sourceSqlite);
  if (sqliteInfo.isSymbolicLink() || !sqliteInfo.isFile()) {
    throw new Error(
      `Backup SQLite file is not a regular file: ${sourceSqlite}`,
    );
  }
  const actualSqlite = await sha256File(sourceSqlite);
  if (
    actualSqlite.bytes !== manifest.sqliteBytes ||
    actualSqlite.sha256 !== manifest.sqliteSha256
  ) {
    throw new Error(
      'Backup SQLite checksum mismatch. Restore aborted to protect data.',
    );
  }

  const sourceBlobsDir = join(backupDir, 'blobs');
  const blobEntries = Object.entries(manifest.blobs);
  if (blobEntries.length !== manifest.blobCount) {
    throw new Error('Backup manifest blob count does not match blob listing.');
  }

  for (const [key, expected] of blobEntries) {
    await verifyRegularBlobFile(sourceBlobsDir, key, expected);
  }

  const force = Boolean(options.force);
  const lockFiles = [
    restoreLockPathForDb(canonicalPath(targetDbPath)),
    restoreLockPathForBlobs(canonicalPath(targetBlobsDir)),
  ];

  return withExclusiveLocks(lockFiles, async () => {
    // Recover any interrupted prior restore before checking destination state or staging.
    recoverInterruptedRestoreSync(targetDbPath, { alreadyLocked: true });
    await assertRestoreTargetsWritable(targetDbPath, targetBlobsDir, force);

    const stageId = randomUUID();
    const dbParent = dirname(targetDbPath);
    const blobsParent = dirname(targetBlobsDir);
    await mkdir(dbParent, { recursive: true, mode: 0o700 });
    await mkdir(blobsParent, { recursive: true, mode: 0o700 });

    const stagedDb = `${targetDbPath}.restore-stage-${stageId}`;
    const stagedBlobsDir = join(blobsParent, `.blobs-restore-stage-${stageId}`);
    const prevDbPath = `${targetDbPath}.restore-prev-${stageId}`;
    const prevWalPath = `${targetDbPath}-wal.restore-prev-${stageId}`;
    const prevShmPath = `${targetDbPath}-shm.restore-prev-${stageId}`;
    const prevBlobsDir = join(blobsParent, `.blobs-restore-prev-${stageId}`);

    let journalWritten = false;
    let journal: RestoreSwapJournal | null = null;

    try {
      // 1. Copy and checksum the backup SQLite database into writable staging FIRST,
      // then run integrity and blob-reference checks on the writable staged copy so
      // WAL-header backups on read-only mounts (e.g. Docker `:ro`) never fail with SQLITE_CANTOPEN.
      await copyFile(sourceSqlite, stagedDb);
      await chmod(stagedDb, 0o600);
      const stagedMeta = await sha256File(stagedDb);
      if (
        stagedMeta.bytes !== manifest.sqliteBytes ||
        stagedMeta.sha256 !== manifest.sqliteSha256
      ) {
        throw new Error('Staged SQLite database checksum mismatch.');
      }

      let referencedBlobs = new Map<string, ExpectedBlob>();
      const snapshotCheck = new sqlite.DatabaseSync(stagedDb);
      try {
        if (!integrityCheck(snapshotCheck)) {
          throw new Error(
            'Backup SQLite snapshot failed PRAGMA integrity_check.',
          );
        }
        referencedBlobs = extractSqliteBlobRefs(snapshotCheck);
      } finally {
        snapshotCheck.close();
      }

      for (const [key, expected] of referencedBlobs) {
        const manifestEntry = manifest.blobs[key];
        if (!manifestEntry) {
          throw new Error(
            `Backup manifest is missing SQLite-referenced blob: ${key}`,
          );
        }
        if (
          manifestEntry.bytes !== expected.bytes ||
          manifestEntry.sha256 !== expected.sha256
        ) {
          throw new Error(
            `Backup manifest size/hash metadata for blob ${key} does not match SQLite snapshot.`,
          );
        }
      }

      const stagedVerify = openDatabase(stagedDb, SCHEMA_VERSION, {
        skipRestoreRecovery: true,
      });
      try {
        if (!ready(stagedVerify) || !integrityCheck(stagedVerify)) {
          throw new Error(
            'Staged SQLite database failed readiness verification.',
          );
        }
        stagedVerify.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        stagedVerify.exec('PRAGMA journal_mode=DELETE');
      } finally {
        stagedVerify.close();
      }

      // 2. Stage and verify complete replacement blob directory before touching live workspace.
      await mkdir(stagedBlobsDir, { recursive: true, mode: 0o700 });
      for (const [key, expected] of blobEntries) {
        const dst = join(stagedBlobsDir, key);
        await copyFile(join(sourceBlobsDir, key), dst);
        await chmod(dst, 0o600);
        const copied = await sha256File(dst);
        if (
          copied.bytes !== expected.bytes ||
          copied.sha256 !== expected.sha256
        ) {
          throw new Error(`Staged blob checksum mismatch for ${key}.`);
        }
      }

      // 3. Re-verify overwrite permission under the lock immediately before swapping,
      // then persist a durable swap journal next to the target database.
      await assertRestoreTargetsWritable(targetDbPath, targetBlobsDir, force);

      const hadPrevDb = existsSync(targetDbPath);
      const hadPrevWal = existsSync(`${targetDbPath}-wal`);
      const hadPrevShm = existsSync(`${targetDbPath}-shm`);
      const hadPrevBlobs = existsSync(targetBlobsDir);

      journal = {
        version: 1,
        stageId,
        phase: 'swapping',
        targetDbPath,
        targetBlobsDir,
        stagedDbPath: stagedDb,
        stagedBlobsDir,
        prevDbPath,
        prevWalPath,
        prevShmPath,
        prevBlobsDir,
        hadPrevDb,
        hadPrevWal,
        hadPrevShm,
        hadPrevBlobs,
        createdAt: new Date().toISOString(),
      };
      await writeRestoreJournal(journal);
      journalWritten = true;

      // 4. Move previous workspace aside without deleting it yet.
      if (hadPrevDb) {
        await rename(targetDbPath, prevDbPath);
      }
      if (hadPrevWal) {
        await rename(`${targetDbPath}-wal`, prevWalPath);
      }
      if (hadPrevShm) {
        await rename(`${targetDbPath}-shm`, prevShmPath);
      }
      if (hadPrevBlobs) {
        await rename(targetBlobsDir, prevBlobsDir);
      }

      // 5. Swap staged replacement into live locations.
      await rename(stagedBlobsDir, targetBlobsDir);
      await rename(stagedDb, targetDbPath);

      // 6. Verify live restored workspace before committing the journal and discarding previous files.
      const restoredDb = openDatabase(targetDbPath, SCHEMA_VERSION, {
        skipRestoreRecovery: true,
      });
      try {
        if (!ready(restoredDb) || !integrityCheck(restoredDb)) {
          throw new Error(
            'Restored SQLite database failed readiness verification.',
          );
        }
        const restoredRefs = extractSqliteBlobRefs(restoredDb);
        for (const [key, expected] of restoredRefs) {
          await verifyRegularBlobFile(targetBlobsDir, key, expected);
        }
      } finally {
        restoredDb.close();
      }

      // 7. Mark swap committed before deleting previous workspace backups.
      await writeRestoreJournal({ ...journal, phase: 'committed' });
    } catch (err) {
      if (journalWritten) {
        try {
          recoverInterruptedRestoreSync(targetDbPath, { alreadyLocked: true });
        } catch {
          // Leave durable journal in place so next restore/startup can retry recovery.
        }
      } else {
        await rm(stagedDb, { force: true }).catch(() => {});
        await rm(`${stagedDb}-wal`, { force: true }).catch(() => {});
        await rm(`${stagedDb}-shm`, { force: true }).catch(() => {});
        await rm(stagedBlobsDir, { recursive: true, force: true }).catch(
          () => {},
        );
      }
      throw err;
    }

    // 8. Replacement is live, verified, and committed; clean up previous workspace and journal.
    await rm(prevDbPath, { force: true });
    await rm(prevWalPath, { force: true });
    await rm(prevShmPath, { force: true });
    await rm(prevBlobsDir, { recursive: true, force: true });
    await removeRestoreJournal(targetDbPath);

    return {
      manifest,
      databasePath: targetDbPath,
      blobDirectory: targetBlobsDir,
      restoredBlobs: blobEntries.length,
    };
  });
}
