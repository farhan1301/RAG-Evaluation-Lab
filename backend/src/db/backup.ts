import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as sqlite from 'node:sqlite';
import { z } from '@rag-eval/contracts';
import {
  integrityCheck,
  openDatabase,
  ready,
  SCHEMA_VERSION,
} from './database.js';
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

function isSafeBlobName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

/**
 * Creates a consistent online backup of the SQLite database (using node:sqlite's
 * online backup API, falling back to VACUUM INTO on older Node 22.13-22.15)
 * together with the private blob directory and a verified SHA-256 manifest.
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
  if (!existsSync(sourceDbPath)) {
    throw new Error(`SQLite database not found: ${sourceDbPath}`);
  }

  if (existsSync(outputDir)) {
    const existing = await readdir(outputDir);
    if (existing.length > 0 && !options.overwrite) {
      throw new Error(
        `Backup destination already exists and is not empty: ${outputDir} (pass --overwrite to replace).`,
      );
    }
    if (options.overwrite) {
      await rm(outputDir, { recursive: true, force: true });
    }
  }

  const destBlobsDir = join(outputDir, 'blobs');
  await mkdir(destBlobsDir, { recursive: true, mode: 0o700 });

  const tempDbPath = join(outputDir, 'workspace.sqlite.tmp');
  const destDbPath = join(outputDir, 'workspace.sqlite');

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
  const verifyDb = new sqlite.DatabaseSync(tempDbPath);
  try {
    if (!integrityCheck(verifyDb)) {
      throw new Error('SQLite backup failed PRAGMA integrity_check.');
    }
    schemaVersion = Number(
      verifyDb.prepare('PRAGMA user_version').get()?.user_version ?? 0,
    );
  } finally {
    verifyDb.close();
  }

  await rename(tempDbPath, destDbPath);
  await chmod(destDbPath, 0o600);
  const sqliteMeta = await sha256File(destDbPath);

  const blobs: Record<string, { bytes: number; sha256: string }> = {};
  if (existsSync(sourceBlobsDir)) {
    const entries = await readdir(sourceBlobsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !isSafeBlobName(entry.name)) continue;
      const src = join(sourceBlobsDir, entry.name);
      const dst = join(destBlobsDir, entry.name);
      await copyFile(src, dst);
      await chmod(dst, 0o600);
      blobs[entry.name] = await sha256File(dst);
    }
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

  const manifestTmp = join(outputDir, 'manifest.json.tmp');
  const manifestPath = join(outputDir, 'manifest.json');
  await writeFile(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(manifestTmp, manifestPath);

  return manifest;
}

/**
 * Verifies a backup directory against its manifest and integrity checks,
 * then restores the SQLite database and private blob directory into target paths.
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

  const manifestPath = join(backupDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Backup manifest not found: ${manifestPath}`);
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
  const actualSqlite = await sha256File(sourceSqlite);
  if (
    actualSqlite.bytes !== manifest.sqliteBytes ||
    actualSqlite.sha256 !== manifest.sqliteSha256
  ) {
    throw new Error(
      'Backup SQLite checksum mismatch. Restore aborted to protect data.',
    );
  }

  const snapshotCheck = new sqlite.DatabaseSync(sourceSqlite, {
    readOnly: true,
  });
  try {
    if (!integrityCheck(snapshotCheck)) {
      throw new Error('Backup SQLite snapshot failed PRAGMA integrity_check.');
    }
  } finally {
    snapshotCheck.close();
  }

  const sourceBlobsDir = join(backupDir, 'blobs');
  const blobEntries = Object.entries(manifest.blobs);
  if (blobEntries.length !== manifest.blobCount) {
    throw new Error('Backup manifest blob count does not match blob listing.');
  }
  for (const [key, expected] of blobEntries) {
    if (!isSafeBlobName(key)) {
      throw new Error(`Unsafe blob key in backup manifest: ${key}`);
    }
    const blobPath = join(sourceBlobsDir, key);
    if (!existsSync(blobPath)) {
      throw new Error(`Backup blob file missing: ${key}`);
    }
    const info = await stat(blobPath);
    if (!info.isFile()) {
      throw new Error(`Backup blob entry is not a regular file: ${key}`);
    }
    const actual = await sha256File(blobPath);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`Backup blob checksum mismatch for ${key}.`);
    }
  }

  if (existsSync(targetDbPath) && !options.force) {
    throw new Error(
      `Target SQLite database already exists: ${targetDbPath}. Stop app/worker and re-run with --force to replace it.`,
    );
  }

  await mkdir(dirname(targetDbPath), { recursive: true, mode: 0o700 });
  const stagedDb = `${targetDbPath}.restore.tmp`;
  await copyFile(sourceSqlite, stagedDb);
  await chmod(stagedDb, 0o600);

  // Remove any stale WAL/SHM sidecars so SQLite never replays old frames onto the restored DB.
  await rm(`${targetDbPath}-wal`, { force: true });
  await rm(`${targetDbPath}-shm`, { force: true });
  await rename(stagedDb, targetDbPath);

  if (options.force && existsSync(targetBlobsDir)) {
    const existingBlobs = await readdir(targetBlobsDir, {
      withFileTypes: true,
    });
    for (const entry of existingBlobs) {
      await rm(join(targetBlobsDir, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
  await mkdir(targetBlobsDir, { recursive: true, mode: 0o700 });
  for (const [key] of blobEntries) {
    const dst = join(targetBlobsDir, key);
    await copyFile(join(sourceBlobsDir, key), dst);
    await chmod(dst, 0o600);
  }

  const restoredDb = openDatabase(targetDbPath);
  try {
    if (!ready(restoredDb) || !integrityCheck(restoredDb)) {
      throw new Error(
        'Restored SQLite database failed readiness verification.',
      );
    }
  } finally {
    restoredDb.close();
  }

  return {
    manifest,
    databasePath: targetDbPath,
    blobDirectory: targetBlobsDir,
    restoredBlobs: blobEntries.length,
  };
}
