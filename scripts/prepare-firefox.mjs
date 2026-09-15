import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'artifacts');
const source = path.join(artifacts, 'firefox-source');
await build('firefox');
if (path.dirname(source) !== artifacts) throw new Error('Invalid source destination');
await rm(source, { recursive: true, force: true });
await mkdir(path.join(source, 'scripts'), { recursive: true });
// Explicit allowlist: never copy the checkout or artifacts containing private credentials.
for (const entry of ['extension', 'review', 'LICENSE', 'scripts/build.mjs']) {
  await cp(path.join(root, entry), path.join(source, entry), { recursive: true });
}
await writeFile(path.join(source, 'README.md'), await readFile(path.join(root, 'review/README.md')));
console.log('Firefox package: ' + path.join(artifacts, 'firefox'));
console.log('Reviewer sources: ' + source);
