import { join } from 'node:path';
import { loadEnvironment, readConfig } from '../config/env.js';
import { backupWorkspace } from '../db/backup.js';
import { blobDirectory } from '../ingestion/blobs.js';

function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv: string[]) {
  let outputDir = '';
  let overwrite = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      const next = argv[++i];
      if (!next) throw new Error('Expected a directory path after --out.');
      outputDir = next;
    } else if (arg === '--overwrite') {
      overwrite = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: npm run backup -- [--out <backup-dir>] [--overwrite]',
          '',
          'Creates a SQLite + blobs workspace backup with a SHA-256 manifest.',
          'Backing up to an existing destination (--overwrite) is an offline operation: stop app and worker first.',
        ].join('\n'),
      );
      process.exit(0);
    } else if (!arg.startsWith('-') && !outputDir) {
      outputDir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    outputDir:
      outputDir || join('backups', `rag-eval-backup-${timestampSlug()}`),
    overwrite,
  };
}

if (process.env.NODE_ENV !== 'test') loadEnvironment();
const args = parseArgs(process.argv.slice(2));
const config = readConfig();
const manifest = await backupWorkspace({
  databasePath: config.env.DATABASE_PATH,
  blobDirectory: blobDirectory(config),
  outputDir: args.outputDir,
  overwrite: args.overwrite,
});
console.log(
  JSON.stringify(
    {
      status: 'ok',
      outputDir: args.outputDir,
      schemaVersion: manifest.schemaVersion,
      sqliteBytes: manifest.sqliteBytes,
      blobCount: manifest.blobCount,
      createdAt: manifest.createdAt,
    },
    null,
    2,
  ),
);
