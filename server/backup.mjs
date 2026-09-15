import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const directory = '/var/lib/keyloom/backups';
await mkdir(directory, { recursive: true, mode: 0o700 });
const database = new DatabaseSync(process.env.KEYLOOM_DATABASE, { readOnly: true });
try {
  const name = new Date().toISOString().slice(0, 10) + '.sqlite';
  await backup(database, path.join(directory, name));
  const files = (await readdir(directory)).filter(file => /^\d{4}-\d{2}-\d{2}\.sqlite$/.test(file)).sort();
  for (const file of files.slice(0, -7)) await unlink(path.join(directory, file));
} finally {
  database.close();
}
