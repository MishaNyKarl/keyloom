(() => {
  const $ = id => document.getElementById(id);
  const api = globalThis.browser ?? globalThis.chrome;
  const available = Boolean(api?.runtime?.id) && new URLSearchParams(location.search).get('demo') !== '1';
  let busy = false;
  let initialized = false;
  function failure(action, error) {
    $('sync-status').textContent = KeyloomDiagnostics.report(action, error);
  }
  function codeError(code) { return Object.assign(new Error(code), { code }); }
  async function message(payload) {
    let timer;
    try {
      const reply = await Promise.race([
        api.runtime.sendMessage(payload),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(codeError('BACKGROUND_ERROR')), 30_000); })
      ]);
      if (!reply?.ok) throw codeError(reply?.code ?? 'BACKGROUND_ERROR');
      if (reply.synchronized === false) throw codeError(reply.errorCode ?? 'SYNC_DISABLED');
      return reply;
    } finally { clearTimeout(timer); }
  }
  async function refresh() {
    if (!available || busy) return;
    try {
      const { sync = {} } = await message({ type: 'GET_STATE' });
      if (busy) return;
      if (!initialized) {
        if (!$('sync-url').value) $('sync-url').value = sync.url || '';
        initialized = true;
      }
      $('sync-now').disabled = !sync.enabled;
      $('sync-disconnect').disabled = !sync.enabled;
      $('sync-status').textContent = sync.enabled
        ? `Последняя синхронизация: ${sync.date ? new Date(sync.date).toLocaleString('ru-RU') : 'ещё не было'}. На сервере: ${sync.total ?? 0} тестов.`
        : 'Синхронизация выключена. Введи адрес и ключ, затем нажми «Подключить».';
      if (sync.error) failure('sync', codeError(sync.errorCode ?? 'NETWORK_ERROR'));
    } catch (error) { failure('load', error); }
  }
  function setBusy(value, text) {
    busy = value;
    $('sync-form').setAttribute('aria-busy', String(value));
    for (const id of ['sync-url', 'sync-token', 'sync-connect', 'sync-now', 'sync-disconnect']) {
      $(id).disabled = value || !available;
    }
    if (text) $('sync-status').textContent = text;
  }
  $('sync-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!available || busy) return;
    setBusy(true, 'Проверяем настройки и ожидаем разрешение браузера…');
    let succeeded = false;
    try {
      const config = KeyloomSync.configuration({ url: $('sync-url').value.trim(), token: $('sync-token').value.trim() });
      // Call request directly inside the user gesture, before any await.
      const granted = await api.permissions.request({ origins: ['https://' + new URL(config.url).hostname + '/*'],
        ...(api.runtime.getManifest().browser_specific_settings?.gecko
          ? { data_collection: ['websiteActivity', 'authenticationInfo'] } : {}) });
      if (!granted) throw codeError('PERMISSION_DENIED');
      $('sync-status').textContent = 'Подключаемся и передаём историю… Ожидание до 30 секунд.';
      await message({ type: 'CONNECT_SYNC', config });
      $('sync-token').value = '';
      succeeded = true;
    } catch (error) { failure('connect', error); }
    finally { setBusy(false); }
    if (succeeded) { $('diagnostics').hidden = true; await refresh(); }
  });
  for (const [id, type, action, text] of [
    ['sync-now', 'SYNC_NOW', 'sync', 'Синхронизируем историю… Ожидание до 30 секунд.'],
    ['sync-disconnect', 'DISCONNECT_SYNC', 'disconnect', 'Отключаем синхронизацию…']
  ]) {
    $(id).addEventListener('click', async () => {
      if (!available || busy) return;
      setBusy(true, text);
      let succeeded = false;
      try { await message({ type }); succeeded = true; }
      catch (error) { failure(action, error); }
      finally { setBusy(false); }
      if (succeeded) { $('diagnostics').hidden = true; await refresh(); }
    });
  }
  setBusy(false);
  if (available) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.syncStatus || changes.syncConfig)) void refresh();
    });
    void refresh();
  } else $('sync-status').textContent = 'Подключение доступно только в установленном расширении, вне деморежима.';
})();
