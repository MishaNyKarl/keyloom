(() => {
  const messages = {
    CONFIG_INVALID: 'Проверь HTTPS-адрес и ключ доступа (32–256 символов).',
    SERVER_PORT: 'Для сервера Keyloom нужен адрес https://45.11.229.77:8443 — проверь порт.',
    PERMISSION_DENIED: 'Доступ к серверу не разрешён. Повтори подключение и разреши доступ.',
    NETWORK_ERROR: 'Не удалось соединиться с сервером. Проверь адрес, порт, интернет и сертификат HTTPS.',
    TIMEOUT: 'Сервер не ответил вовремя. Проверь адрес и порт, затем повтори попытку.',
    HTTP_401: 'Сервер отклонил ключ доступа. Проверь ключ и подключись заново.',
    HTTP_ERROR: 'Сервер вернул ошибку. Повтори попытку позже.',
    INVALID_RESPONSE: 'Ответ сервера имеет неподдерживаемый формат.',
    SYNC_DISABLED: 'Сначала подключи сервер, указав адрес и личный ключ.',
    BACKGROUND_ERROR: 'Нет ответа от фоновой части расширения. Перезагрузи расширение и открой панель заново.',
    UI_ERROR: 'Ошибка интерфейса. Скопируй диагностику и пришли её для исправления.',
    CLIPBOARD_ERROR: 'Не удалось скопировать. Выдели текст диагностики и скопируй вручную.'
  };
  const $ = id => document.getElementById(id);
  function report(action, error, line = 0) {
    const code = Object.hasOwn(messages, error?.code) ? error.code : 'UI_ERROR';
    const safeAction = ['connect', 'sync', 'disconnect', 'load', 'dashboard', 'uncaught', 'promise', 'copy'].includes(action) ? action : 'dashboard';
    const api = globalThis.browser ?? globalThis.chrome;
    const version = api?.runtime?.getManifest?.().version ?? 'preview';
    const name = ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error';
    // Deliberately exclude raw messages, stacks, URLs, keys and session contents.
    $('diagnostics-text').value = JSON.stringify({ app: 'Keyloom', version,
      time: new Date().toISOString(), action: safeAction, code, name,
      line: Number.isInteger(line) ? line : 0 }, null, 2);
    $('diagnostics-message').textContent = messages[code];
    $('diagnostics').hidden = false;
    $('diagnostics-copy').textContent = 'Скопировать диагностику';
    return messages[code];
  }
  $('diagnostics-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('diagnostics-text').value);
      $('diagnostics-copy').textContent = 'Скопировано';
    } catch {
      $('diagnostics-message').textContent = messages.CLIPBOARD_ERROR;
      $('diagnostics-text').focus();
      $('diagnostics-text').select();
    }
  });
  $('diagnostics-close').addEventListener('click', () => { $('diagnostics').hidden = true; });
  window.addEventListener('error', event => report('uncaught', event.error, event.lineno));
  window.addEventListener('unhandledrejection', event => report('promise', event.reason));
  globalThis.KeyloomDiagnostics = Object.freeze({ report });
})();
