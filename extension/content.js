/* Monkeytype DOM adapter. Isolated world; no account access and no page patches. */
(() => {
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  if (globalThis.__keyloomLoaded) return;
  globalThis.__keyloomLoaded = true;
  const core = globalThis.KeyloomCore;
  let settings = { enabled: false, layout: 'default' }, session = null, firstNode = null;
  let status = 'Готов к тесту', badge, checkQueued = false, disabledForTest = false;
  let trainingPlan=null,lastSavedId=null,pendingSave=Promise.resolve();
  let dailyState = null, nextButton, comparisonNote, panel, widget, theme = 'dark', advancing = false;
  let todayProgress = null, progressPanel;
  const send = async message => {
    try {
      const reply = await extensionApi.runtime.sendMessage(message);
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
      badge.addEventListener('click', () => void pendingSave.then(()=>send({ type: 'OPEN_DASHBOARD', sessionId:lastSavedId })).catch(() => {}));
      panel = document.createElement('div');
      panel.id = 'keyloom-panel';
      const open = document.createElement('button');
      open.id = 'keyloom-open-app';
      open.type = 'button';
      open.textContent = 'Открыть Keyloom';
      open.addEventListener('click', () => {
        void send({ type: 'OPEN_DASHBOARD' }).catch(() => {});
      });
      nextButton = document.createElement('button');
      nextButton.id = 'keyloom-next-step';
      nextButton.type = 'button';
      nextButton.setAttribute('aria-keyshortcuts', 'Alt+N');
      nextButton.addEventListener('click', advance);
      comparisonNote = document.createElement('span');
      comparisonNote.id = 'keyloom-daily-comparison';
      panel.append(badge, open, nextButton, comparisonNote);
      widget = document.createElement('div');
      widget.id = 'keyloom-widget';
      widget.setAttribute('role', 'region');
      widget.setAttribute('aria-label', 'Keyloom — результаты и команды');
      widget.append(panel);
      document.body.append(widget);
      progressPanel = document.createElement('div');
      progressPanel.id = 'keyloom-progress';
      progressPanel.setAttribute('role', 'status');
      progressPanel.setAttribute('aria-live', 'polite');
      document.body.append(progressPanel);
    }
    if (widget.isConnected === false) document.body.append(widget);
    if (progressPanel.isConnected === false) document.body.append(progressPanel);
    widget.setAttribute('data-typing', String(Boolean(session)));
    widget.inert = Boolean(session);
    widget.setAttribute('data-keyloom-theme', ['dark', 'light', 'repose-dark', 'lime', 'honey', 'dualshot', 'trackday'].includes(theme) ? theme : 'dark');
    progressPanel.setAttribute('data-keyloom-theme', theme);
    progressPanel.hidden = !todayProgress;
    const progressText = todayProgress ?
      todayProgress.done + ' / ' + todayProgress.total + ' заданий    ≈ ' + todayProgress.minutes + ' мин осталось' : '';
    if (progressPanel.textContent !== progressText) progressPanel.textContent = progressText;
    panel.setAttribute('data-typing', String(Boolean(session)));
    panel.inert = Boolean(session);
    const label = `Keyloom: ${settings.enabled ? status : 'На паузе'}`;
    if (badge.textContent !== label) badge.textContent = label;
    nextButton.hidden = !dailyState || dailyState.completed || Boolean(session) || !settings.enabled;
    nextButton.disabled = advancing;
    const nextLabel = advancing ? 'Открываю…' : 'Следующее задание (Alt+N)';
    if (nextButton.textContent !== nextLabel) nextButton.textContent = nextLabel;
    nextButton.title = dailyState?.nextLabel ?? '';
    const comparisons = dailyState?.comparisons ?? [];
    comparisonNote.hidden = !comparisons.length || Boolean(session);
    const comparisonText = comparisons.map(row =>
      `${row.language === 'russian' ? 'RU' : 'EN'}: до ${row.before.toFixed(1)} с → после ${row.after.toFixed(1)} с; точность ${row.beforeAccuracy.toFixed(1)}% → ${row.afterAccuracy.toFixed(1)}%`
    ).join(' · ') + (comparisons.length ? '. Повтор знакомого текста — результат этой тренировки, не оценка общего прогресса.' : '');
    if (comparisonNote.textContent !== comparisonText) comparisonNote.textContent = comparisonText;
  }
  async function advance() {
    if (advancing || session || !dailyState || dailyState.completed) return;
    advancing = true;
    status = 'Открываю следующее задание…';
    paint();
    try {
      await send({type:'NEXT_DAILY'});
    } catch (error) {
      advancing = false;
      status = 'Не удалось перейти: ' + error.message;
      paint();
    }
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
    pendingSave=send({ type: 'SAVE_SESSION', session: result, configuredSeconds:finished.configuredSeconds }).then(reply => {
      if(reply.saved)lastSavedId=result.id;
      dailyState = reply.daily ?? null;
      if (session) return; // A delayed save response must not overwrite a new test's status.
      status = 'На паузе';
      if (reply.saved) {
        status = statusValue === 'completed' ? 'Тест сохранён' : 'Тест прерван';
        if (dailyState?.completed) status = 'Ежедневный план завершён!';
        if (statusValue === 'completed' && reply.dailyStep === 'mismatch') {
          status = 'Тест сохранён · шаг не засчитан: открой его из плана';
        }
      }
      paint();
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
      session = { id: crypto.randomUUID(), date: Date.now(), path: location.pathname, configuredSeconds:configuration.configuredSeconds, language: trainingPlan?.language ?? configuration.language ?? (/[а-яё]/iu.test(target) ? 'russian' : 'english'),
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
    if (!document.hidden) void refreshProgress();
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
    const commands = KeyloomKeyboard.create({
      theme: () => theme,
      canOpen: () => !session && !document.querySelector('dialog[open]:not(#keyloom-command-menu)') &&
        (!document.activeElement?.closest?.('input, textarea, select, [contenteditable="true"]') ||
          document.activeElement.id === 'wordsInput' ||
          document.activeElement.closest?.('#keyloom-command-menu')),
      commands: [
        {label:'Разогреть пальчики', alias:'warmup разминка ошибки',
          run:() => pendingSave.then(() => send({type:'START_WARMUP',
            language:KeyloomConfiguration.read(document).language ?? trainingPlan?.language ?? 'english'}))},
        {label:'Следующее задание', alias:'next daily lesson', key:'KeyN',
          available:() => settings.enabled && Boolean(dailyState) && !dailyState.completed && !advancing,
          run:advance},
        {label:'Открыть Keyloom', alias:'dashboard overview', key:'KeyO',
          run:() => pendingSave.then(() => send({type:'OPEN_DASHBOARD',sessionId:lastSavedId}))},
        {label:'Продолжить сегодняшний план', alias:'daily plan сегодня создать продолжить',
          run:() => pendingSave.then(() => send({type:'RESUME_TODAY'}))}
      ]
    });
    const menu = document.createElement('button');
    menu.type = 'button';
    menu.id = 'keyloom-open-commands';
    menu.textContent = 'Команды (Alt+K)';
    menu.setAttribute('aria-keyshortcuts', 'Alt+K');
    menu.addEventListener('click', commands.open);
    panel.append(menu);
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
  void send({ type: 'GET_STATE' }).then(state => {
    theme = state.theme ?? 'dark';
    settings = state.settings;
    trainingPlan = state.training ?? null;
    dailyState = state.daily ?? null;
    todayProgress = state.today ?? null;
    if (dailyState?.completed) status = 'Ежедневный план завершён!';
    paint();
  }).catch(() => {});
  async function refreshProgress() {
    try {
      const reply = await send({type:'GET_TODAY_PROGRESS'});
      todayProgress = reply.today ?? null;
      paint();
    } catch {
      // send() already displays the connection error in the status panel.
    }
  }
  extensionApi.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.dailies || changes.settings) void refreshProgress();
    if (changes.theme) { theme = changes.theme.newValue; paint(); }
    if (!changes.settings) return;
    settings = changes.settings.newValue;
    session = null; status = settings.enabled ? 'Начните новый тест' : 'На паузе'; paint();
  });
})();
