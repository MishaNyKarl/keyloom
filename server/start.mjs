import { createApp } from './app.mjs';

const server = createApp({ filename: process.env.KEYLOOM_DATABASE,
  token: process.env.KEYLOOM_TOKEN });
server.listen(Number(process.env.PORT ?? 8791), '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close());
}
