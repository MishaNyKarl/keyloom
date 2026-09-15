import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build, firefoxManifest } from '../scripts/build.mjs';

test('packages keep shared sources and load the Firefox event page in manifest order', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'keyloom-build-'));
  try {
    const chrome = await build('chrome', temporary);
    const firefox = await build('firefox', temporary);
    const readManifest = async directory => JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const original = await readManifest(chrome);
    const manifest = await readManifest(firefox);
    assert.equal(original.background.service_worker, 'background.js');
    assert.equal(manifest.background.service_worker, undefined);
    assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '142.0');
    assert.equal(manifest.browser_specific_settings.gecko_android, undefined);
    assert.equal(firefoxManifest(original).background.scripts.at(-1), 'background.js');
    assert.equal(original.browser_specific_settings, undefined);
    assert.deepEqual(manifest.permissions, original.permissions);
    assert.equal(await readFile(path.join(chrome, 'content.js'), 'utf8'), await readFile(path.join(firefox, 'content.js'), 'utf8'));
    assert.ok(!(await readdir(firefox)).includes('test'));
    let listener;
    const context = vm.createContext({ crypto: webcrypto, URL, TextEncoder,
      browser: { runtime: { onMessage: { addListener: fn => listener = fn } } }
    });
    for (const script of manifest.background.scripts) {
      vm.runInContext(await readFile(path.join(firefox, script), 'utf8'), context);
    }
    assert.equal(typeof listener, 'function');
    assert.equal(typeof context.KeyloomPractice.url, 'function');
    assert.equal(context.chrome, undefined);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('build rejects unknown targets without modifying output directories', async () => {
  await assert.rejects(build('../outside'), /Unknown browser target/);
});

test('popup reads storage and opens dashboard with either browser API namespace', async () => {
  const source = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
  for (const namespace of ['browser', 'chrome']) {
    const elements = Object.fromEntries(['status', 'enabled', 'count', 'open'].map(id => [id, {
      addEventListener(event, callback) { this[event] = callback; }
    }]));
    const messages = [];
    let closed = false;
    const context = vm.createContext({
      document: { getElementById: id => elements[id] },
      window: { close: () => closed = true },
      [namespace]: { runtime: { async sendMessage(message) {
        messages.push(message);
        return { ok: true, settings: { enabled: true }, sessions: [{ status: 'completed' }] };
      } } }
    });
    vm.runInContext(source, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(elements.count.textContent, 1, namespace);
    await elements.open.click();
    assert.equal(messages.at(-1).type, 'OPEN_DASHBOARD');
    assert.equal(closed, true);
  }
});
