import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import '../extension/core.js';

const core = globalThis.KeyloomCore;
const digest = value => createHash('sha256').update(value).digest();
const fields = ['id', 'date', 'language', 'layout', 'mode', 'status', 'source',
  'duration', 'presses', 'corrections', 'accuracy', 'wpm'];

export function canonicalSession(session) {
  if (!core.validateSession(session)) throw new Error('Invalid session');
  const clean = Object.fromEntries(fields.map(key => [key, session[key]]));
  for (const group of ['chars', 'pairs', 'sequences', 'words', 'uppercase', 'digits', 'punctuation']) {
    if (!session[group]) continue;
    clean[group] = Object.fromEntries(Object.entries(session[group]).map(([key, value]) =>
      [key, { attempts: value.attempts, errors: value.errors, timings: value.timings }]));
  }
  if (session.training) {
    clean.training = Object.fromEntries(['id', 'kind', 'targets', 'seconds', 'wordCount']
      .filter(key => session.training[key] !== undefined).map(key => [key, session.training[key]]));
  }
  return clean;
}

export function createApp({ filename, token }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('A strong token is required');
  const secret = digest('Bearer ' + token);
  const database = new DatabaseSync(filename);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, date REAL NOT NULL, payload TEXT NOT NULL)');
  const insert = database.prepare('INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING');
  const count = database.prepare('SELECT COUNT(*) AS count FROM sessions');
  const recent = database.prepare('SELECT payload FROM sessions ORDER BY date DESC, id DESC LIMIT 160');
  const server = createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify(body));
    };
    if (request.url === '/health' && request.method === 'GET') return reply(200, { ok: true });
    if (!timingSafeEqual(secret, digest(request.headers.authorization ?? ''))) {
      request.resume();
      return reply(401, { error: 'Unauthorized' });
    }
    if (request.url !== '/v1/sync' || request.method !== 'POST') return reply(404, { error: 'Not found' });
    if (request.headers['content-type'] !== 'application/json') return reply(415, { error: 'JSON required' });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8_000_000) { reply(413, { error: 'Payload too large' }); return; }
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (payload.version !== 1 || !Array.isArray(payload.sessions) || payload.sessions.length > 160) {
        return reply(400, { error: 'Invalid sync payload' });
      }
      const sessions = payload.sessions.map(canonicalSession);
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const session of sessions) insert.run(session.id, session.date, JSON.stringify(session));
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      const latest = core.mergeSessions([], recent.all().map(row => JSON.parse(row.payload)));
      reply(200, { version: 1, sessions: latest, total: count.get().count });
    } catch (error) {
      // Never log request bodies, tokens, words or database errors containing data.
      const invalid = error instanceof SyntaxError || error.message === 'Invalid session';
      reply(invalid ? 400 : 500, { error: invalid ? 'Invalid sync payload' : 'Storage unavailable' });
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.on('close', () => database.close());
  return server;
}
