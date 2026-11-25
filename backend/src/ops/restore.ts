import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvironment, readConfig, type Config } from '../config/env.js';
import {
  assertRestoreDestination,
  samePath,
  pathsOverlap,
  restoreWorkspace,
} from '../db/backup.js';
import { blobDirectory } from '../ingestion/blobs.js';

export interface RestoreCliArgs {
  backupDir: string;
  force: boolean;
  databasePath?: string;
  blobDir?: string;
}

export function parseRestoreArgs(argv: string[]): RestoreCliArgs {
  let backupDir = '';
  let force = false;
  let databasePath: string | undefined;
  let blobDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from' || arg === '-f') {
      const next = argv[++i];
      if (!next) throw new Error('Expected a backup directory after --from.');
      backupDir = next;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--database') {
      const next = argv[++i];
      if (!next) throw new Error('Expected a path after --database.');
      databasePath = next;
    } else if (arg === '--blobs') {
      const next = argv[++i];
      if (!next) throw new Error('Expected a path after --blobs.');
      blobDir = next;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: npm run restore -- --from <backup-dir> [--force] [--database <path>] [--blobs <dir>]',
          '',
          'Restores a verified SQLite + blobs workspace backup.',
          'Restoring over an existing workspace (--force) is an offline operation: stop app and worker first.',
        ].join('\n'),
      );
      process.exit(0);
    } else if (!arg.startsWith('-') && !backupDir) {
      backupDir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!backupDir) {
    throw new Error(
      'Specify a backup directory: npm run restore -- --from <backup-dir> [--force]',
    );
  }
  return { backupDir, force, databasePath, blobDir };
}

export function resolveRestoreTargets(
  args: RestoreCliArgs,
  config: Config,
): { databasePath: string; blobDirectory: string } {
  const configuredDb = config.env.DATABASE_PATH;
  const configuredBlobs = blobDirectory(config);
  const databasePath = args.databasePath ?? configuredDb;
  assertRestoreDestination(databasePath);
  let blobs = args.blobDir ?? configuredBlobs;
  if (
    args.databasePath &&
    !args.blobDir &&
    (configuredDb === ':memory:' || !samePath(databasePath, configuredDb))
  ) {
    blobs = join(dirname(resolve(databasePath)), 'blobs');
    if (pathsOverlap(blobs, configuredBlobs)) {
      throw new Error(
        `Implicit blob destination (${resolve(blobs)}) overlaps the configured workspace blob directory (${resolve(configuredBlobs)}). Pass an explicit distinct --blobs directory.`,
      );
    }
  }
  assertRestoreDestination(blobs);
  return { databasePath, blobDirectory: blobs };
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(resolve(process.argv[1])) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  }
}

if (isMainModule()) {
  if (process.env.NODE_ENV !== 'test') loadEnvironment();
  const args = parseRestoreArgs(process.argv.slice(2));
  const config = readConfig();
  const targets = resolveRestoreTargets(args, config);
  const result = await restoreWorkspace({
    backupDir: args.backupDir,
    databasePath: targets.databasePath,
    blobDirectory: targets.blobDirectory,
    force: args.force,
  });
  console.log(
    JSON.stringify(
      {
        status: 'ok',
        databasePath: result.databasePath,
        blobDirectory: result.blobDirectory,
        schemaVersion: result.manifest.schemaVersion,
        restoredBlobs: result.restoredBlobs,
      },
      null,
      2,
    ),
  );
}
