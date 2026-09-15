import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../extension/', import.meta.url));
let count = 0;
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await walk(file);
    else if (file.endsWith('.js') || file.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      count++;
    }
  }
}
await walk(root);
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const background = manifest.background.scripts ?? [manifest.background.service_worker];
for (const file of [...manifest.content_scripts.flatMap(s => s.js), ...background, manifest.action.default_popup, manifest.options_page, 'vendor/lz-string.js', 'vendor/lz-string.LICENSE']) {
  await access(path.join(root, file));
}
for (const icon of Object.values(manifest.icons ?? {})) await access(path.join(root, icon));
for (const file of manifest.content_scripts.flatMap(script => script.css ?? [])) {
  await access(path.join(root, file));
}
const themes = await readFile(path.join(root, 'themes.css'), 'utf8');
for (const match of themes.matchAll(/url\('([^']+)'\)/g)) {
  if (!match[1].startsWith('fonts/')) throw new Error('Fonts must be bundled locally');
  await access(path.join(root, match[1]));
}
await access(path.join(root, 'fonts/OFL.txt'));
for (const page of ['dashboard.html', 'popup.html', 'privacy.html']) {
  const html = await readFile(path.join(root, page), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)) await access(path.join(root, match[1]));
  if (/\son\w+\s*=|<script\b[^>]*>\s*[^<\s]/i.test(html)) throw new Error('Inline scripts are incompatible with extension CSP');
}
console.log(`Checked ${count} JavaScript files, manifest entries, assets, and extension-page CSP in ${root}.`);
