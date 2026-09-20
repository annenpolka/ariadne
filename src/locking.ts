import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

/** Kernel-backed SQLite file lock; process death releases it without deleting a stale PID file. */
export function acquireFileLock(base: string): () => void {
  const path = `${base}.sqlite`; mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(fd);
  const identity = lstatSync(path); if (!identity.isFile() || identity.isSymbolicLink()) throw new Error('State lock must be a regular file');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS ariadne_mutex (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE');
  } catch (error) {
    db?.close();
    if (error instanceof Error && /locked|busy/.test(error.message)) throw new Error('State is locked by another live process', { cause: error });
    throw error;
  }
  const owner = db;
  return () => {
    try {
      const current = lstatSync(path);
      if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error('State lock ownership changed');
    } finally {
      try { owner.exec('ROLLBACK'); } finally { owner.close(); }
    }
  };
}
