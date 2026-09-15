import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';

const token = 'synthetic-test-token-with-at-least-32-characters';
const session = id => KeyloomCore.analyze([
  { target: 'cat', wordIndex: 0, position: 0, typed: 'c', type: 'insert', time: 0 },
  { target: 'cat', wordIndex: 0, position: 1, typed: 'a', type: 'insert', time: 100 }
], { id });

test('API authenticates, validates atomically, deduplicates and retains history after restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'keyloom-api-'));
  let server;
  const start = async () => {
    server = createApp({ filename: path.join(directory, 'history.sqlite'), token });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return 'http://127.0.0.1:' + server.address().port;
  };
  const stop = () => new Promise(resolve => server.close(resolve));
  try {
    let url = await start();
    const sync = (sessions, key = token) => fetch(url + '/v1/sync', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, sessions })
    });
    assert.equal((await sync([], 'wrong')).status, 401);
    assert.equal((await sync([session('a'), { id: 'invalid' }])).status, 400);
    assert.equal((await (await sync([])).json()).total, 0);
    const data = session('a');
    data.rawInput = 'must not persist';
    data.chars.c.rawInput = 'must not persist';
    await Promise.all([sync([data]), sync([session('b')]), sync([data])]);
    const result = await (await sync([])).json();
    assert.equal(result.total, 2);
    assert.equal(JSON.stringify(result).includes('must not persist'), false);
    await stop();
    url = await start();
    assert.equal((await (await sync([])).json()).total, 2);
    await sync(Array.from({ length: 160 }, (_, i) => session('extra-' + i)));
    const retained = await (await sync([])).json();
    assert.equal(retained.total, 162);
    assert.equal(retained.sessions.length, 160);
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
