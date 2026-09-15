import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/core.js';
import '../extension/sync.js';

const token = 'synthetic-token-with-at-least-32-characters';
test('sync accepts HTTPS IP origins, rejects unsafe URLs and weak keys', () => {
  assert.deepEqual(KeyloomSync.configuration({ url: 'https://192.0.2.1:8443/', token }),
    { enabled: true, url: 'https://192.0.2.1:8443', token });
  for (const url of ['http://example.com', 'https://a:b@example.com', 'https://example.com/path', 'https://example.com/?token=x']) {
    assert.throws(() => KeyloomSync.configuration({ url, token }));
  }
  assert.throws(() => KeyloomSync.configuration({ url: 'https://example.com', token: 'short' }));
});
test('sync merges validated data and refuses redirects, unauthenticated and oversized responses', async () => {
  const config = { url: 'https://192.0.2.1:8443', token };
  const session = KeyloomCore.analyze([], { id: 'remote' });
  const result = await KeyloomSync.exchange(config, [], async (url, options) => {
    assert.equal(url, config.url + '/v1/sync');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    return Response.json({ version: 1, total: 1, sessions: [session] });
  });
  assert.equal(result.sessions[0].id, 'remote');
  await assert.rejects(KeyloomSync.exchange(config, [], async () => new Response('', { status: 401 })), /ключ/);
  await assert.rejects(KeyloomSync.exchange(config, [], async () => Response.json({ version: 1, total: 1, sessions: [{}] })), /сессий/);
  await assert.rejects(KeyloomSync.exchange(config, [], async () => new Response(' '.repeat(8_000_001))), /слишком большой/);
});
