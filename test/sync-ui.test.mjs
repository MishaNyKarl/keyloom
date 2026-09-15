import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function harness() {
  const elements = Object.fromEntries(['sync-form', 'sync-url', 'sync-token', 'sync-connect',
    'sync-now', 'sync-disconnect', 'sync-status', 'diagnostics', 'diagnostics-text',
    'diagnostics-message', 'diagnostics-copy', 'diagnostics-close'].map(id => [id, {
    value: '', hidden: true, textContent: '', disabled: false,
    addEventListener(type, callback) { this[type] = callback; },
    setAttribute() {}, focus() {}, select() {}
  }]));
  const calls = [];
  let copied;
  const api = {
    runtime: { id: 'test', getManifest: () => ({ version: 'test' }),
      sendMessage: async message => {
        calls.push(message);
        return { ok: true, sync: { enabled: false } };
      } },
    permissions: { request: async () => true },
    storage: { onChanged: { addListener() {} } }
  };
  const window = { addEventListener(type, callback) { this[type] = callback; } };
  const context = vm.createContext({ chrome: api, window, document: { getElementById: id => elements[id] },
    location: { search: '' }, navigator: { clipboard: { writeText: async text => { copied = text; } } },
    URL, URLSearchParams, setTimeout, clearTimeout });
  // No dashboard, charts, core or analytics: sync controls must initialize independently.
  for (const name of ['diagnostics', 'sync', 'sync-ui']) {
    vm.runInContext(await readFile(new URL('../extension/' + name + '.js', import.meta.url), 'utf8'), context);
  }
  await new Promise(resolve => setImmediate(resolve));
  const submit = () => elements['sync-form'].submit({ preventDefault() {} });
  return { elements, api, calls, submit, context, window, copied: () => copied };
}

test('wrong port immediately shows persistent, copyable diagnostics without secrets', async () => {
  const h = await harness();
  h.elements['sync-url'].value = 'https://45.11.229.77:84';
  h.elements['sync-token'].value = 'private-synthetic-key-with-more-than-32-characters';
  await h.submit();
  assert.equal(h.elements.diagnostics.hidden, false);
  assert.match(h.elements['sync-status'].textContent, /8443/);
  assert.equal(h.calls.some(call => call.type === 'CONNECT_SYNC'), false);
  await h.elements['diagnostics-copy'].click();
  assert.equal(JSON.parse(h.copied()).code, 'SERVER_PORT');
  assert.equal(h.copied().includes('private-synthetic'), false);
  assert.equal(h.elements['sync-connect'].disabled, false);
});

test('connect displays progress, blocks double submission and reports permission denial', async () => {
  const h = await harness();
  let permission;
  h.api.permissions.request = () => new Promise(resolve => { permission = resolve; });
  h.elements['sync-token'].value = 'synthetic-token-with-more-than-32-characters';
  const pending = h.submit();
  assert.equal(h.elements['sync-connect'].disabled, true);
  assert.match(h.elements['sync-status'].textContent, /разрешение/);
  await h.submit();
  permission(false);
  await pending;
  assert.equal(JSON.parse(h.elements['diagnostics-text'].value).code, 'PERMISSION_DENIED');
  assert.equal(h.elements['sync-connect'].disabled, false);
});

test('manual sync surfaces background failure; uncaught errors never copy raw values', async () => {
  const h = await harness();
  h.api.runtime.sendMessage = async () => ({ ok: true, synchronized: false, errorCode: 'HTTP_401' });
  await h.elements['sync-now'].click();
  assert.match(h.elements['sync-status'].textContent, /ключ/);
  h.window.error({ error: new TypeError('SECRET raw history https://secret.example'), lineno: 12 });
  const output = h.elements['diagnostics-text'].value;
  assert.equal(output.includes('SECRET'), false);
  assert.equal(output.includes('secret.example'), false);
  assert.equal(JSON.parse(output).line, 12);
});
