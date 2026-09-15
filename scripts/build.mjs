import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export function firefoxManifest(chromium) {
  const manifest = structuredClone(chromium);
  manifest.background = {
    scripts: ['core.js', 'analytics.js', 'vendor/lz-string.js', 'practice.js', 'sync.js', 'background.js']
  };
  manifest.browser_specific_settings = {
    gecko_android: { strict_min_version: '142.0' },
    gecko: {
      id: 'keyloom@mishanykarl',
      strict_min_version: '140.0',
      // Exercise text goes to Monkeytype; optional sync also sends typing statistics.
      data_collection_permissions: {
        required: ['websiteContent'], optional: ['websiteActivity', 'authenticationInfo']
      }
    }
  };
  return manifest;
}

export async function build(target, artifacts = path.join(root, 'artifacts')) {
  if (!['chrome', 'firefox'].includes(target)) throw new Error('Unknown browser target');
  const output = path.resolve(artifacts, target);
  if (path.dirname(output) !== path.resolve(artifacts)) throw new Error('Invalid output path');
  await mkdir(artifacts, { recursive: true });
  await rm(output, { recursive: true, force: true });
  await cp(path.join(root, 'extension'), output, { recursive: true });
  const original = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
  const manifest = target === 'firefox' ? firefoxManifest(original) : original;
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targets = process.argv[2] ? [process.argv[2]] : ['chrome', 'firefox'];
  for (const target of targets) console.log(await build(target));
}
