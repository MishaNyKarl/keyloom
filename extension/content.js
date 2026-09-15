/* Monkeytype DOM adapter. Isolated world; no account access and no page patches. */
(() => {
  if (globalThis.__keyloomLoaded) return;
  globalThis.__keyloomLoaded = true;
  const core = globalThis.KeyloomCore;
  let settings = { enabled: false, layout: 'default' }, session = null, firstNode = null;
  let status = 'Готов к тесту', badge, checkQueued = false, disabledForTest = false;
  let trainingPlan=null,lastSavedId=null,pendingSave=Promise.resolve();
  const send = async message => {
    try {
      const reply = await chrome.runtime.sendMessage(message);
      if (!reply?.ok) throw new Error(reply?.error ?? 'Нет связи с расширением');
      return reply;
    } catch (error) { status = 'Не сохранено · обновите вкладку'; paint(); throw error; }
  };
  const visible = el => !!el && !el.closest('.hidden') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  function paint() {
    if (!document.body) return;
    if (!badge) {
      badge = document.createElement('button');
      badge.id = 'keyloom-status';
      badge.type = 'button';
      badge.title = 'Открыть статистику Keyloom';
      badge.style.cssText = 'position:fixed;bottom:14px;right:18px;z-index:1000;border:1px solid #5b6155;border-radius:8px;background:#20251f;color:#dbe7b7;font:12px/1.4 system-ui;padding:8px 12px;cursor:pointer;opacity:.85';
      badge.addEventListener('click', () => void pendingSave.then(()=>send({ type: 'OPEN_DASHBOARD', sessionId:lastSavedId })).catch(() => {}));
      document.body.append(badge);
    }
    const label = `keyloom · ${settings.enabled ? status : 'На паузе'}`;
    if (badge.textContent !== label) badge.textContent = label;
  }
  function targetText(node) {
    return Array.from(node.querySelectorAll('letter:not(.extra)')).map(l => l.textContent).join('').normalize('NFC');
  }
  const selectedButton = KeyloomConfiguration.selected;
  function mode() {
    const buttons = document.querySelectorAll('[data-ui-element="testConfig"] button, #testConfig button');
    const selected = Array.from(buttons).find(selectedButton);
    const activeMode = Array.from(buttons).find(b => ['time','words','custom','quote','zen'].includes(b.textContent.trim()) &&
      selectedButton(b));
    return activeMode?.textContent.trim() ?? selected?.getAttribute('mode') ?? 'unknown';
  }
  function finish(statusValue) {
    const finished = session;
    session = null;
    if (!finished || finished.events.length < 2) return;
    if(finished.training && (statusValue==='completed' && finished.maxWordIndex!==trainingPlan?.words.length-1)) delete finished.training;
    const result = core.analyze(finished.events, { ...finished, status: statusValue });
    // Persist aggregates only. Raw input and the full test text never leave this content script.
    pendingSave=send({ type: 'SAVE_SESSION', session: result }).then(reply => {
      if(reply.saved)lastSavedId=result.id;
      if (session) return; // A delayed save response must not overwrite a new test's status.
      status = reply.saved ? (statusValue === 'completed' ? 'Тест сохранён' : 'Тест прерван') : 'На паузе'; paint();
    }).catch(() => {});
  }
  function check() {
    checkQueued = false;
    const root = document.querySelector('#words');
    const first = root?.querySelector('.word');
    const testVisible = visible(document.querySelector('#typingTest'));
    const resultVisible = visible(document.querySelector('#result'));
    if (session && location.pathname !== session.path) finish('abandoned');
    // Monkeytype hides typing before asynchronously revealing results. The gap is
    // not a cancellation signal, regardless of animation/calculation duration.
    if (resultVisible) { finish('completed'); paint(); return; }
    // Generated DOM nodes change on restart; removed first lines in timed tests do not reset index to zero.
    const readyForNewTest = testVisible && first?.getAttribute('data-wordindex') === '0' &&
      document.querySelector('#wordsInput')?.value === ' ';
    if (first && first !== firstNode && readyForNewTest) {
      if (firstNode) finish('abandoned');
      disabledForTest = false;
      firstNode = first;
      if (!session) status = 'Готов к тесту';
    }
    if (session && !testVisible) status = 'Ожидаю результаты';
    paint();
  }
  function queueCheck() {
    if (!checkQueued) { checkQueued = true; requestAnimationFrame(check); }
  }
  function capture(event) {
    if (event.target?.id !== 'wordsInput' || !settings.enabled || !event.isTrusted) return;
    check();
    if (disabledForTest) return;
    if (!visible(document.querySelector('#typingTest')) || visible(document.querySelector('#result'))) return;
    const node = document.querySelector('#words .word.active');
    if (!node) return;
    if (event.isComposing || event.inputType?.includes('Composition') || event.inputType === 'insertFromPaste') {
      session = null; disabledForTest = true; status = 'IME / вставка · тест пропущен'; paint(); return;
    }
    const deleting = event.inputType?.startsWith('delete');
    if (!deleting && (event.inputType !== 'insertText' || [...(event.data ?? '')].length !== 1)) return;
    const target = targetText(node);
    // Accept supported quote tokens; never broaden collection beyond the test input.
    if (!core.supportedToken(target)) {
      session = null; disabledForTest = true; status = 'Неподдерживаемые символы в тексте'; paint(); return;
    }
    const value = event.target.value;
    if (!value.startsWith(' ') || !node.hasAttribute('data-wordindex')) {
      session = null; disabledForTest = true; status = 'Разметка изменилась · запись отключена'; paint(); return;
    }
    if (!session) {
      const configuration = KeyloomConfiguration.read(document);
      if (!configuration.ok) { disabledForTest = true; status = configuration.reason; paint(); return; }
      const testMode = mode();
      if (!['time', 'words', 'custom', 'quote'].includes(testMode)) { status = 'Режим не поддерживается'; paint(); return; }
      // Never collect a partial session when enabled or installed midway through a test.
      if (node.getAttribute('data-wordindex') !== '0' || value !== ' ' || deleting) { status = 'Начните новый тест'; paint(); return; }
      session = { id: crypto.randomUUID(), date: Date.now(), path: location.pathname, language: trainingPlan?.language ?? configuration.language ?? (/[а-яё]/iu.test(target) ? 'russian' : 'english'),
        layout: settings.layout, mode: testMode, events: [] };
      if(trainingPlan && testMode==='custom' && trainingPlan.layout===settings.layout && trainingPlan.language===session.language)session.training={id:trainingPlan.id,kind:trainingPlan.kind,targets:trainingPlan.targets,seconds:trainingPlan.seconds,...(trainingPlan.wordCount ? {wordCount:trainingPlan.wordCount} : {})};
    }
    if (!trainingPlan && /[а-яё]/iu.test(target)) session.language = 'russian';
    const wordIndex=Number(node.getAttribute('data-wordindex'));
    session.maxWordIndex=Math.max(session.maxWordIndex??0,wordIndex);
    if(session.training && trainingPlan.words[wordIndex]!==target)delete session.training;
    if (session.events.length >= core.MAX_EVENTS) { finish('abandoned'); disabledForTest = true; status = 'Лимит длины теста'; paint(); return; }
    session.events.push({ type: deleting ? 'delete' : 'insert', time: performance.now(),
      wordIndex: Number(node.getAttribute('data-wordindex')), target,
      position: [...value.slice(1)].length, typed: event.data ?? '' });
    status = 'Записываю тест'; paint();
  }
  document.addEventListener('beforeinput', capture, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && session) {
      const last = session.events.at(-1);
      session.events.push({ ...last, type: 'break', time: performance.now() });
    }
  });
  document.addEventListener('click', event => {
    if (event.target.closest?.('#restartTestButton')) { check(); finish('abandoned'); }
  }, true);
  function mount() {
    new MutationObserver(records => {
      if (records.some(r => r.target !== badge && !badge?.contains(r.target))) queueCheck();
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
    check();
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
  void send({ type: 'GET_STATE' }).then(state => { settings = state.settings; trainingPlan=state.training??null; paint(); }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = changes.settings.newValue;
    session = null; status = settings.enabled ? 'Начните новый тест' : 'На паузе'; paint();
  });
})();
