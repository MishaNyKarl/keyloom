importScripts('core.js','analytics.js','vendor/lz-string.js','practice.js');
const defaults = { enabled: true, layout: 'default' };
// Serialize read-modify-write operations from multiple Monkeytype tabs.
let queue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const fromExtension = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  const fromMonkeytype = sender.id === chrome.runtime.id && sender.url?.startsWith('https://monkeytype.com/');
  if (!fromExtension && !fromMonkeytype) return;
  queue = queue.catch(() => {}).then(async () => {
    const { sessions = [], settings = defaults, exercises = [] } = await chrome.storage.local.get(['sessions', 'settings','exercises']);
    if (message.type === 'GET_STATE') {
      const id=fromMonkeytype?new URL(sender.url).searchParams.get('keyloomExercise'):null;
      return { sessions: fromExtension ? sessions : [], settings, ...(fromExtension?{exercises}:{training:exercises.find(p=>p.id===id)??null}) };
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
      await chrome.storage.local.set({ sessions: next });
      return { saved: true };
    }
    if (message.type === 'OPEN_DASHBOARD') {
      const result=sessions.find(s=>s.id===message.sessionId);
      const suffix=result?'?session='+encodeURIComponent(result.id)+'&language='+result.language+'#practice':'';
      await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html')+suffix });
      return { opened: true };
    }
    if (!fromExtension) throw new Error('Недоступная операция');
    if(message.type==='START_PRACTICE'){
      if(!settings.enabled)throw new Error('Включите запись тестов перед тренировкой');
      const plan=message.plan;
      if(!KeyloomAnalytics.validPlan(plan))throw new Error('Некорректная тренировка');
      if(plan.layout!==settings.layout)throw new Error('Профиль раскладки изменился. Подберите тренировку заново.');
      await chrome.storage.local.set({exercises:[...exercises.filter(p=>p.id!==plan.id),plan].slice(-40)});
      await chrome.tabs.create({url:KeyloomPractice.url(plan.words,plan.language,plan.id)});
      return {id:plan.id};
    }
    if (message.type === 'SET_SETTINGS') {
      const next = { enabled: Boolean(message.settings.enabled), layout: message.settings.layout === 'alternate' ? 'alternate' : 'default' };
      await chrome.storage.local.set({ settings: next });
      return { settings: next };
    }
    if (message.type === 'IMPORT') {
      const next = KeyloomCore.mergeSessions(sessions, message.sessions);
      await chrome.storage.local.set({ sessions: next });
      return { count: next.length };
    }
    throw new Error('Неизвестная операция');
  });
  queue.then(data => respond({ ok: true, ...data }), error => respond({ ok: false, error: error.message }));
  return true;
});
