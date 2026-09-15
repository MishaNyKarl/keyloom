(() => {
  function configuration(value) {
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/' || !/^[A-Za-z0-9_-]{32,256}$/.test(value.token ?? '')) {
      throw new Error('Нужны HTTPS-адрес сервера и личный ключ (32–256 символов)');
    }
    return { enabled: true, url: url.origin, token: value.token };
  }

  async function exchange(config, sessions, fetcher = fetch) {
    const response = await fetcher(config.url + '/v1/sync', {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token },
      body: JSON.stringify({ version: 1, sessions }), signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) {
      throw new Error(response.status === 401 ? 'Сервер отклонил ключ доступа' : 'Сервер временно недоступен');
    }
    // Bound decoded response size even when the server streams without Content-Length.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '', size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8_000_000) { await reader.cancel(); throw new Error('Ответ сервера слишком большой'); }
      text += decoder.decode(value, { stream: true });
    }
    const data = JSON.parse(text + decoder.decode());
    if (data.version !== 1 || !Number.isInteger(data.total) || data.total < 0) {
      throw new Error('Некорректный ответ сервера');
    }
    return { sessions: KeyloomCore.mergeSessions(sessions, data.sessions), total: data.total };
  }
  globalThis.KeyloomSync = Object.freeze({ configuration, exchange });
})();
