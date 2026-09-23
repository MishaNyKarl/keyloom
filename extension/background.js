if (typeof importScripts === 'function') {
  importScripts('core.js', 'analytics.js', 'learning.js', 'daily.js', 'words.js', 'vendor/lz-string.js', 'practice.js', 'sync.js');
}
const extensionApi = globalThis.browser ?? globalThis.chrome;
const defaults = { enabled: true, layout: 'default' };
// Serialize read-modify-write operations from multiple Monkeytype tabs.
let queue = Promise.resolve();
function dailyContinuation(dailies, url) {
  const params = new URL(url).searchParams;
  const daily = dailies.find(plan => plan.id === params.get('keyloomDaily'));
  const index = daily?.steps.findIndex(step => step.id === params.get('keyloomStep')) ?? -1;
  if (index < 0 || !daily.steps[index].result) return null;
  const next = daily.steps.find(step => !step.result);
  if (next && next !== daily.steps[index + 1]) return null;
  return { nextLabel: next?.label ?? null, completed: !next,
    comparisons:KeyloomDaily.comparisons(daily) };
}
function syncPermissions(config) {
  return { origins: ['https://' + new URL(config.url).hostname + '/*'],
    ...(extensionApi.runtime.getManifest?.().browser_specific_settings?.gecko
      ? { data_collection: ['websiteActivity', 'authenticationInfo'] } : {}) };
}
async function synchronize() {
  const { syncConfig, sessions = [], learning } = await extensionApi.storage.local.get(['syncConfig', 'sessions', 'learning']);
  if (!syncConfig?.enabled) return { synchronized: false, errorCode: 'SYNC_DISABLED' };
  try {
    if (!await extensionApi.permissions.contains(syncPermissions(syncConfig))) {
      throw Object.assign(new Error('Sync permission revoked'), { code: 'PERMISSION_DENIED' });
    }
    const result = await KeyloomSync.exchange(syncConfig, sessions);
    await extensionApi.storage.local.set({ sessions: result.sessions,
      learning: KeyloomLearning.ingest(learning, result.sessions),
      syncStatus: { date: Date.now(), total: result.total, error: null } });
    return { synchronized: true };
  } catch (error) {
    const { syncStatus = {} } = await extensionApi.storage.local.get('syncStatus');
    await extensionApi.storage.local.set({ syncStatus: { ...syncStatus,
      error: 'Не удалось синхронизировать. Проверьте соединение и ключ; повторим автоматически.',
      errorCode: error.code ?? 'NETWORK_ERROR' } });
    return { synchronized: false, errorCode: error.code ?? 'NETWORK_ERROR' };
  }
}
function scheduleSync() {
  return extensionApi.alarms?.create('keyloom-sync-soon', { delayInMinutes: 0.5 });
}
extensionApi.alarms?.create('keyloom-sync', { periodInMinutes: 5 });
extensionApi.alarms?.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith('keyloom-sync')) queue = queue.catch(() => {}).then(synchronize);
});
extensionApi.runtime.onMessage.addListener((message, sender, respond) => {
  const fromExtension = sender.id === extensionApi.runtime.id && sender.url?.startsWith(extensionApi.runtime.getURL(''));
  const fromMonkeytype = sender.id === extensionApi.runtime.id && sender.url?.startsWith('https://monkeytype.com/');
  if (!fromExtension && !fromMonkeytype) return;
  queue = queue.catch(() => {}).then(async () => {
    const { sessions = [], settings = defaults, exercises = [], learning: savedLearning,
      dailies: savedDailies = [], dailyPrefs, theme } = await extensionApi.storage.local.get(['sessions', 'settings','exercises', 'learning', 'dailies', 'dailyPrefs', 'theme']);
    let dailies = savedDailies;
    if (['GET_STATE', 'GET_TODAY_PROGRESS', 'RESUME_TODAY'].includes(message.type)) {
      dailies = KeyloomDaily.schedule(dailies, dailyPrefs, sessions, settings.layout);
      if (dailies !== savedDailies) await extensionApi.storage.local.set({dailies});
    }
    const learning = savedLearning ?? KeyloomLearning.ingest(null, sessions);
    if (!savedLearning) await extensionApi.storage.local.set({learning});
    if (message.type === 'START_WARMUP') {
      if (!settings.enabled) throw new Error('Включите запись тестов перед тренировкой');
      const language = message.language;
      if (!['english','russian'].includes(language)) throw new Error('Выберите English или Русский');
      if (fromMonkeytype && !Number.isInteger(sender.tab?.id)) throw new Error('Не удалось определить вкладку');
      const dictionary = [...KeyloomWords[language], ...KeyloomLearning.vocabulary(learning, language, settings.layout)];
      const plan = KeyloomAnalytics.warmup(sessions, dictionary, language, settings.layout);
      if (!KeyloomAnalytics.validPlan(plan)) throw new Error('Не удалось подготовить разминку');
      await extensionApi.storage.local.set({exercises:[...exercises, plan].slice(-40)});
      const destination = {url:KeyloomPractice.url(plan.words, language, plan.id)};
      try {
        if (fromMonkeytype) await extensionApi.tabs.update(sender.tab.id, destination);
        else await extensionApi.tabs.create(destination);
      } catch (error) {
        await extensionApi.storage.local.set({exercises});
        throw error;
      }
      return {started:true};
    }
    if (message.type === 'GET_TODAY_PROGRESS') {
      return {today:KeyloomDaily.todaySummary(dailies, settings.layout)};
    }
    if (message.type === 'GET_STATE') {
      const id=fromMonkeytype?new URL(sender.url).searchParams.get('keyloomExercise'):null;
      const { syncConfig, syncStatus } = fromExtension
        ? await extensionApi.storage.local.get(['syncConfig', 'syncStatus']) : {};
      const sync = { enabled: Boolean(syncConfig?.enabled), url: syncConfig?.url ?? '', ...syncStatus };
      return { theme, today:KeyloomDaily.todaySummary(dailies, settings.layout), sessions: fromExtension ? sessions : [], settings, ...(fromExtension?{exercises,sync,learning,dailies,dailyPrefs}:{training:exercises.find(p=>p.id===id)??null, daily:dailyContinuation(dailies, sender.url)}) };
    }
    if (message.type === 'SAVE_SESSION' && fromMonkeytype) {
      if (!settings.enabled) return { ignored: true };
      const incoming={...message.session};
      if(incoming.training){
        const id=new URL(sender.url).searchParams.get('keyloomExercise');
        const plan=exercises.find(p=>p.id===id&&p.id===incoming.training.id&&p.language===incoming.language&&p.layout===incoming.layout);
        if(!plan||incoming.mode!=='custom') delete incoming.training;
        else incoming.training={id:plan.id,targets:plan.targets,kind:plan.kind,seconds:plan.seconds,...(plan.wordCount ? {wordCount:plan.wordCount} : {})};
      }
      const next = KeyloomCore.mergeSessions(sessions, [incoming]);
      const accepted = next.find(row => row.id === incoming.id);
      let updatedDailies = accepted ? KeyloomDaily.complete(dailies, accepted, sender.url, message.configuredSeconds) : dailies;
      const newlyCompleted = updatedDailies.some(plan => plan.steps.every(step => step.result) &&
        dailies.find(previous => previous.id === plan.id)?.steps.some(step => !step.result));
      if (newlyCompleted) {
        updatedDailies = KeyloomDaily.schedule(updatedDailies, dailyPrefs, next, settings.layout,
          Date.now(), true);
      }
      await extensionApi.storage.local.set({ sessions: next,
        learning: KeyloomLearning.ingest(learning, [incoming]),
        dailies: updatedDailies });
      await scheduleSync();
      const completedPlan = updatedDailies.find(plan =>
        plan.steps.some(step => step.result?.id === incoming.id) &&
        plan.steps.every(step => step.result) &&
        dailies.find(previous => previous.id === plan.id)?.steps.some(step => !step.result));
      if (completedPlan) {
        // Persist before navigating; duplicate delivery must not open another result tab.
        try {
          await extensionApi.tabs.create({url:extensionApi.runtime.getURL('dashboard.html') +
            '?dailyResult=' + encodeURIComponent(completedPlan.id) + '#daily'});
        } catch { /* The saved result remains available in daily plan history. */ }
      }
      let dailyStep;
      if (new URL(sender.url).searchParams.has('keyloomDaily')) {
        dailyStep = updatedDailies.some(plan => plan.steps.some(step => step.result?.id === incoming.id)) ? 'completed' : 'mismatch';
      }
      return { saved: true, dailyStep, daily:dailyContinuation(updatedDailies, sender.url) };
    }
    if (message.type === 'OPEN_DASHBOARD') {
      const result=sessions.find(s=>s.id===message.sessionId);
      const dailyResult = dailies.some(plan => plan.steps.some(step => step.result?.id === result?.id && result));
      const dailyView = message.view === 'daily' && (fromExtension ||
        dailies.some(plan => plan.id === new URL(sender.url).searchParams.get('keyloomDaily')));
      let suffix = '';
      if (dailyResult || dailyView) suffix = '#daily';
      else if (result) suffix = '?session=' + encodeURIComponent(result.id) + '&language=' + result.language + '#practice';
      await extensionApi.tabs.create({ url: extensionApi.runtime.getURL('dashboard.html')+suffix });
      return { opened: true };
    }
    const resuming = message.type === 'RESUME_TODAY';
    const todayPlan = resuming ? dailies.filter(plan =>
      plan.day === KeyloomAnalytics.day(Date.now()) && plan.layout === settings.layout).at(-1) : null;
    if (resuming && (!todayPlan || todayPlan.steps.every(step => step.result))) {
      await extensionApi.tabs.create({url:extensionApi.runtime.getURL('dashboard.html') + '#daily'});
      return {opened:true};
    }
    if (resuming && fromMonkeytype && !Number.isInteger(sender.tab?.id)) {
      throw new Error('Не удалось определить вкладку тренировки');
    }
    const continuing = message.type === 'NEXT_DAILY' && fromMonkeytype;
    if (!fromExtension && !continuing && !resuming) throw new Error('Недоступная операция');
    if (message.type === 'CREATE_DAILY') {
      const plan = KeyloomDaily.create(message.options, sessions, settings.layout);
      if (plan.prefs.targets) {
        for (const step of plan.steps.filter(row => row.type === 'focus')) {
          KeyloomDaily.exercise(plan, step, sessions, learning, KeyloomWords[step.language]);
        }
      }
      const prepared = KeyloomDaily.schedule([...dailies, plan].slice(-30), plan.prefs,
        sessions, settings.layout, Date.now(), true);
      await extensionApi.storage.local.set({dailies:prepared, dailyPrefs:plan.prefs});
      return {plan};
    }
    if (message.type === 'START_DAILY' || continuing || resuming) {
      if (!settings.enabled) throw new Error('Включите запись тестов перед тренировкой');
      const params = continuing ? new URL(sender.url).searchParams : null;
      if (continuing && (!Number.isInteger(sender.tab?.id) || !dailyContinuation(dailies, sender.url))) {
        throw new Error('Сначала завершите текущий шаг плана');
      }
      const daily = todayPlan ?? dailies.find(plan => plan.id === (continuing ? params.get('keyloomDaily') : message.id));
      if (!daily || daily.layout !== settings.layout) throw new Error('План не найден для текущей раскладки');
      const step = daily.steps.find(row => !row.result);
      if (!step) throw new Error('Все шаги плана уже завершены');
      if (continuing && step.startedAt) throw new Error('Следующий шаг уже запущен. Откройте план, чтобы повторить его');
      const previousDailies = structuredClone(dailies);
      let url;
      let updatedExercises = exercises;
      if (['time','quote'].includes(step.type)) {
        url = KeyloomDaily.nativeUrl(daily, step);
      } else {
        const plan = KeyloomDaily.exercise(daily, step, sessions, learning, KeyloomWords[step.language]);
        if (!KeyloomAnalytics.validPlan(plan)) throw new Error('Не удалось подготовить шаг плана');
        step.exerciseId = plan.id;
        step.targets = plan.targets;
        step.kind = plan.kind;
        updatedExercises = [...exercises, plan].slice(-40);
        url = KeyloomPractice.url(plan.words, plan.language, plan.id);
      }
      step.startedAt = Date.now();
      await extensionApi.storage.local.set({dailies, exercises:updatedExercises});
      const destination = {url:url + '&keyloomDaily=' + encodeURIComponent(daily.id) +
        '&keyloomStep=' + encodeURIComponent(step.id)};
      try {
        if (continuing || (resuming && fromMonkeytype)) await extensionApi.tabs.update(sender.tab.id, destination);
        else await extensionApi.tabs.create(destination);
      } catch (error) {
        await extensionApi.storage.local.set({dailies:previousDailies, exercises});
        throw error;
      }
      return {started:true};
    }
    if (message.type === 'CONNECT_SYNC') {
      const config = KeyloomSync.configuration(message.config);
      if (!await extensionApi.permissions.contains(syncPermissions(config))) {
        throw Object.assign(new Error('Разрешите расширению подключение к серверу'), { code: 'PERMISSION_DENIED' });
      }
      const result = await KeyloomSync.exchange(config, sessions);
      await extensionApi.storage.local.set({ syncConfig: config, sessions: result.sessions,
        learning: KeyloomLearning.ingest(learning, result.sessions),
        syncStatus: { date: Date.now(), total: result.total, error: null } });
      return { connected: true };
    }
    if (message.type === 'DISCONNECT_SYNC') {
      await extensionApi.storage.local.set({ syncConfig: null, syncStatus: null });
      return { disconnected: true };
    }
    if (message.type === 'SYNC_NOW') {
      return await synchronize();
    }
    if(message.type==='START_PRACTICE'){
      if(!settings.enabled)throw new Error('Включите запись тестов перед тренировкой');
      const plan=message.plan;
      if(!KeyloomAnalytics.validPlan(plan))throw new Error('Некорректная тренировка');
      if(plan.layout!==settings.layout)throw new Error('Профиль раскладки изменился. Подберите тренировку заново.');
      await extensionApi.storage.local.set({exercises:[...exercises.filter(p=>p.id!==plan.id),plan].slice(-40)});
      await extensionApi.tabs.create({url:KeyloomPractice.url(plan.words,plan.language,plan.id)});
      return {id:plan.id};
    }
    if (message.type === 'SET_SETTINGS') {
      const next = { enabled: Boolean(message.settings.enabled), layout: message.settings.layout === 'alternate' ? 'alternate' : 'default' };
      await extensionApi.storage.local.set({ settings: next });
      return { settings: next };
    }
    if (message.type === 'IMPORT') {
      if (message.layout !== undefined && !['default','alternate'].includes(message.layout)) throw new Error('Некорректная раскладка');
      const importedPlans = KeyloomDaily.importPlans(dailies, message.dailies);
      const importedPrefs = message.dailyPrefs === undefined ? dailyPrefs : KeyloomDaily.options(message.dailyPrefs);
      const next = KeyloomCore.mergeSessions(sessions, message.sessions);
      const mergedLearning = message.learning ? KeyloomLearning.merge(learning, message.learning) : learning;
      await extensionApi.storage.local.set({ sessions: next, settings:{...settings,layout:message.layout ?? settings.layout}, dailies:importedPlans, ...(importedPrefs ? {dailyPrefs:importedPrefs} : {}), learning:KeyloomLearning.ingest(mergedLearning, message.sessions) });
      await scheduleSync();
      return { count: next.length };
    }
    throw new Error('Неизвестная операция');
  });
  queue.then(data => respond({ ok: true, ...data }), error => respond({ ok: false, error: error.message, code: error.code }));
  return true;
});
