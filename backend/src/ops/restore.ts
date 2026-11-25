import { loadEnvironment, readConfig } from '../config/env.js';
import { restoreWorkspace } from '../db/backup.js';
import { blobDirectory } from '../ingestion/blobs.js';

function parseArgs(argv: string[]) {
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
        'Usage: npm run restore -- --from <backup-dir> [--force] [--database <path>] [--blobs <dir>]',
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

if (process.env.NODE_ENV !== 'test') loadEnvironment();
const args = parseArgs(process.argv.slice(2));
const config = readConfig();
const result = await restoreWorkspace({
  backupDir: args.backupDir,
  databasePath: args.databasePath ?? config.env.DATABASE_PATH,
  blobDirectory: args.blobDir ?? blobDirectory(config),
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
