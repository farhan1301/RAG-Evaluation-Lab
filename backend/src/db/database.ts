import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const migrations = [
  '001-definitions.sql',
  '002-ingestion.sql',
  '003-retrieval.sql',
  '004-evaluation.sql',
  '005-generation.sql',
];

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function ready(db: DatabaseSync) {
  return (
    db.prepare('PRAGMA user_version').get()?.user_version === migrations.length
  );
}

export function openDatabase(path: string, targetVersion = migrations.length) {
  if (
    !Number.isInteger(targetVersion) ||
    targetVersion < 1 ||
    targetVersion > migrations.length
  )
    throw new RangeError('Invalid migration target.');
  if (path !== ':memory:')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL',
    );
    transaction(db, () => {
      const version = Number(
        db.prepare('PRAGMA user_version').get()?.user_version,
      );
      if (version > targetVersion)
        throw new Error('Database requires a newer application.');
      for (let i = version; i < targetVersion; i++) {
        db.exec(
          readFileSync(
            new URL(`./migrations/${migrations[i]}`, import.meta.url),
            'utf8',
          ),
        );
        db.exec(`PRAGMA user_version=${i + 1}`);
      }
    });
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
