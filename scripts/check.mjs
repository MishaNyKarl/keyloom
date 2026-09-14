import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
let count = 0;
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await walk(file);
    else if (file.endsWith('.js') || file.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr); count++;
    }
  }
}
await walk(fileURLToPath(new URL('../extension/', import.meta.url)));
const manifest = JSON.parse(await readFile(new URL('extension/manifest.json', root), 'utf8'));
for (const file of [...manifest.content_scripts.flatMap(s => s.js), manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, 'vendor/lz-string.js', 'vendor/lz-string.LICENSE']) await access(new URL(`extension/${file}`, root));
for (const page of ['dashboard.html', 'popup.html']) {
  const html = await readFile(new URL(`extension/${page}`, root), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)) await access(new URL(`extension/${match[1]}`, root));
  if (/\son\w+\s*=|<script\b[^>]*>\s*[^<\s]/i.test(html)) throw new Error('Inline scripts are incompatible with extension CSP');
}
console.log(`Checked ${count} JavaScript files, manifest entries, assets, and extension-page CSP.`);
