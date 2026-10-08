/* Monkeytype DOM adapter. Isolated world; no account access and no page patches. */
(() => {
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  if (globalThis.__keyloomLoaded) return;
  globalThis.__keyloomLoaded = true;
  const core = globalThis.KeyloomCore;
  let settings = { enabled: false, layout: 'default' }, session = null, firstNode = null;
  let status = 'Готов к тесту', badge, checkQueued = false, disabledForTest = false;
  let trainingPlan=null,lastSavedId=null,pendingSave=Promise.resolve();
  let dailyState = null, nextButton, panel, widget, theme = 'dark', advancing = false;
  let todayProgress = null, progressPanel;
  let savingId = null, queuedAdvanceId = null;
  let wordsRoot, testPanel, resultPanel, notificationRoot;
  let testVisible = false, resultVisible = false;
  let lifecycleObserver, bootstrapObserver, observedFirst;
  let observedNodes = new Map(), wordTargets = new WeakMap();
  let activeWord = null;
  let inputRoot = null;
  let diagnostics = null;
  let lastDiagnostics = null;
  function metric(name, elapsed = 0) {
    if (!diagnostics) return;
    const row = diagnostics.metrics[name] ??= {count:0, totalMs:0, maxMs:0, over16Ms:0};
    row.count++;
    row.totalMs += elapsed;
    row.maxMs = Math.max(row.maxMs, elapsed);
    if (elapsed > 16) row.over16Ms++;
  }
  function diagnosticEvent(name) {
    if (!diagnostics) return;
    diagnostics.events.push({name, elapsedMs:performance.now() - diagnostics.started});
    if (diagnostics.events.length > 100) diagnostics.events.shift();
  }
  function startDiagnostics() {
    const report = {version:extensionApi.runtime.getManifest().version,
      started:performance.now(), metrics:{}, events:[], tests:[], mutationRecords:0};
    diagnostics = report;
    lastDiagnostics = report;
    // Passive counters only: no timer or per-keystroke stopwatch. Browser
    // stack sampling belongs to Firefox Profiler, outside this adapter.
    status = 'Диагностика включена · пройдите тест и скачайте отчёт через Alt+K';
    paint();
  }
  function downloadDiagnostics() {
    const snapshot = diagnostics ?? lastDiagnostics;
    if (!snapshot) return;
    const {version, metrics, events, tests, mutationRecords, started} = snapshot;
    const report = {format:2, version, captureTiming:'not-measured',
      eventLoopSampling:false, durationMs:performance.now() - started,
      metrics, events, tests, mutationRecords};
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)],
      {type:'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'keyloom-diagnostics.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const send = async message => {
    try {
      const routed = ['SAVE_SESSION', 'NEXT_DAILY'].includes(message.type) ||
        (message.type === 'GET_STATE' && location.pathname === '/');
      diagnosticEvent('send-' + message.type);
      const reply = await extensionApi.runtime.sendMessage(routed ?
        {pageUrl:location.href, ...message} : message);
      if (!reply?.ok) throw new Error(reply?.error ?? 'Нет связи с расширением');
      return reply;
    } catch (error) {
      diagnosticEvent('message-failed');
      status = 'Не сохранено · обновите вкладку'; paint(); throw error;
    }
  };
  const visible = el => {
    metric('visibilityChecks');
    return !!el && !el.closest('.hidden') && el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== 'hidden';
  };
  // Repeated attribute writes can invalidate the host's cursor/style state while typing.
  function setAttributeIfChanged(node, name, value) {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }
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
      panel.append(badge, open, nextButton);
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
    setAttributeIfChanged(widget, 'data-typing', String(Boolean(session)));
    setAttributeIfChanged(progressPanel, 'data-typing', String(Boolean(session)));
    if (widget.inert !== Boolean(session)) widget.inert = Boolean(session);
    setAttributeIfChanged(widget, 'data-keyloom-theme', ['dark', 'light', 'repose-dark', 'lime', 'honey', 'dualshot', 'trackday'].includes(theme) ? theme : 'dark');
    setAttributeIfChanged(progressPanel, 'data-keyloom-theme', theme);
    if (progressPanel.hidden !== !todayProgress) progressPanel.hidden = !todayProgress;
    const progressText = todayProgress ?
      todayProgress.done + ' / ' + todayProgress.total + ' заданий    ≈ ' + todayProgress.minutes + ' мин осталось' : '';
    if (progressPanel.textContent !== progressText) progressPanel.textContent = progressText;
    setAttributeIfChanged(panel, 'data-typing', String(Boolean(session)));
    if (panel.inert !== Boolean(session)) panel.inert = Boolean(session);
    const label = `Keyloom: ${settings.enabled ? status : 'На паузе'}`;
    if (badge.textContent !== label) badge.textContent = label;
    const hideNext = !canAdvance() || Boolean(session);
    if (nextButton.hidden !== hideNext) nextButton.hidden = hideNext;
    if (nextButton.disabled !== advancing) nextButton.disabled = advancing;
    const nextLabel = advancing ? 'Открываю…' : 'Следующее задание (Alt+N)';
    if (nextButton.textContent !== nextLabel) nextButton.textContent = nextLabel;
    const nextTitle = dailyState?.nextLabel ?? '';
    if (nextButton.title !== nextTitle) nextButton.title = nextTitle;

  }
  function canQueueAdvance() {
    const params = new URL(location.href).searchParams;
    return settings.enabled && !advancing && location.pathname === '/' &&
      params.has('keyloomDaily') && params.has('keyloomStep') &&
      !visible(document.querySelector('#typingTest')) && Boolean(session || savingId);
  }
  function requestAdvance() {
    if (canQueueAdvance()) {
      queuedAdvanceId = session?.id ?? savingId;
      status = 'Следующее задание откроется после сохранения результата';
      paint();
      return;
    }
    return advance();
  }
  function canAdvance() {
    const away = location.pathname !== '/' ||
      !new URL(location.href).searchParams.has('keyloomDaily');
    return settings.enabled && (away ? todayProgress?.done < todayProgress?.total :
      Boolean(dailyState) && !dailyState.completed);
  }
  async function advance() {
    if (advancing || session || !canAdvance()) return;
    advancing = true;
    status = 'Открываю следующее задание…';
    paint();
    try {
      const params = new URL(location.href).searchParams;
      if (location.pathname !== '/' || !params.has('keyloomDaily') || !params.has('keyloomStep')) {
        diagnosticEvent('resume-after-navigation');
        await pendingSave;
        await send({type:'RESUME_TODAY'});
        advancing = false;
        paint();
        return;
      }
      const reply = await send({type:'NEXT_DAILY', inPlace:true});
      if (!reply.url) {
        return;
      }
      let start;
      try {
        start = await KeyloomConfiguration.prepare(document, reply.testSettings);
      } catch {
        // The prepared step is already persisted; its URL is the recovery path.
        location.assign(reply.url);
        return;
      }
      if (!start) {
        location.assign(reply.url);
        return;
      }
      try {
        // Update markers before restarting so trusted input uses the new exercise.
        // Firefox can reject URL updates; the persisted URL also recovers that case.
        history.replaceState(null, '', reply.url);
        trainingPlan = reply.training ?? null;
        firstNode = null;
        disabledForTest = false;
        wordTargets = new WeakMap();
        activeWord = null;
        start();
        // Clicking a host control can silently do nothing (disabled/transitioning).
        // Keep input blocked until the result is replaced by a ready test.
        for (let attempt = 0; attempt < 30; attempt++) {
          if (visible(document.querySelector('#typingTest')) &&
            !visible(document.querySelector('#result'))) {
            dailyState = null;
            advancing = false;
            status = 'Начните следующий тест';
            paint();
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        location.assign(reply.url);
        return;
      } catch {
        location.assign(reply.url);
        return;
      }
    } catch (error) {
      advancing = false;
      status = 'Не удалось перейти: ' + error.message;
      paint();
    }
  }
  function targetText(node) {
    // A word's expected letters are immutable; typing changes classes and adds
    // extra letters. Weak keys do not retain lines removed from long tests.
    if (!wordTargets.has(node)) {
      const text = Array.from(node.querySelectorAll('letter:not(.extra)'))
        .map(letter => letter.textContent).join('').normalize('NFC');
      wordTargets.set(node, text);
    }
    return wordTargets.get(node);
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
    if (session?.abortReason) statusValue = 'abandoned';
    if (statusValue !== 'completed') queuedAdvanceId = null;
    const finished = session;
    session = null;
    if (!finished || finished.events.length < 2) return;
    if(finished.training && (statusValue==='completed' && finished.maxWordIndex!==trainingPlan?.words.length-1)) delete finished.training;
    const analysisStart = diagnostics ? performance.now() : 0;
    const result = core.analyze(finished.events, { ...finished, status: statusValue });
    if (diagnostics) metric('analysis', performance.now() - analysisStart);
    diagnosticEvent('finish-' + statusValue);
    // Persist aggregates only. Raw input and the full test text never leave this content script.
    savingId = result.id;
    dailyState = null;
    status = queuedAdvanceId ? 'Следующее задание откроется после сохранения результата' : 'Сохраняю результат…';
    paint();
    pendingSave=send({ type: 'SAVE_SESSION', session: result,
      configuredSeconds:finished.configuredSeconds,
      configuredWordset:finished.configuredWordset,
      pageUrl:finished.pageUrl }).then(reply => {
      const requested = queuedAdvanceId === result.id;
      if (savingId === result.id) savingId = null;
      if (requested) queuedAdvanceId = null;
      if(reply.saved)lastSavedId=result.id;
      dailyState = reply.daily ?? null;
      diagnosticEvent(reply.saved ? 'save-accepted' : 'save-ignored');
      if (reply.dailyStep) diagnosticEvent('step-' + reply.dailyStep);
      if (diagnostics) {
        const params = new URL(finished.pageUrl).searchParams;
        diagnostics.tests.push({status:statusValue, events:finished.events.length,
          mode:['time', 'words', 'custom', 'quote'].includes(finished.mode) ? finished.mode : 'other',
          language:['english', 'russian'].includes(finished.language) ? finished.language : 'other',
          configuredSeconds:Number.isFinite(finished.configuredSeconds) ? finished.configuredSeconds : null,
          hasPlan:params.has('keyloomDaily'), hasStep:params.has('keyloomStep'),
          hasExercise:params.has('keyloomExercise'), training:Boolean(finished.training),
          saved:Boolean(reply.saved), step:['completed', 'mismatch'].includes(reply.dailyStep) ?
            reply.dailyStep : 'none',
          reason:['plan', 'layout', 'duplicate', 'step', 'not-started', 'start-time',
            'incomplete', 'language', 'mode', 'dictionary', 'duration', 'exercise',
            'invalid-session'].includes(reply.dailyStepReason) ? reply.dailyStepReason : null});
        if (diagnostics.tests.length > 10) diagnostics.tests.shift();
      }
      if (session) return; // A delayed save response must not overwrite a new test's status.
      status = 'На паузе';
      if (reply.saved) {
        status = statusValue === 'completed' ? 'Тест сохранён' : 'Тест прерван';
        if (finished.abortReason === 'performance') {
          status = 'Monkeytype остановил тест из-за производительности';
        } else if (finished.abortReason) {
          status = 'Тест прерван · шаг плана не засчитан';
        }
        if (dailyState?.completed) status = 'Ежедневный план завершён!';
        if (statusValue === 'completed' && reply.dailyStep === 'mismatch') {
          const reasons = {plan:'план не найден', layout:'другая раскладка',
            step:'не совпал шаг', 'not-started':'шаг не был запущен',
            'start-time':'тест начат раньше шага', incomplete:'тест прерван',
            language:'другой язык', mode:'другой режим', dictionary:'другой словарь',
            duration:'другая длительность', exercise:'не совпало упражнение'};
          status = 'Тест сохранён · шаг не засчитан: ' +
            (reasons[reply.dailyStepReason] ?? 'открой его из плана');
        }
      }
      paint();
      if (requested && reply.saved && statusValue === 'completed' &&
        reply.dailyStep !== 'mismatch' && location.pathname === finished.path) void advance();
    }).catch(() => {
      if (savingId === result.id) savingId = null;
      if (queuedAdvanceId === result.id) queuedAdvanceId = null;
    });
  }
  function check() {
    if (!diagnostics) return checkLifecycle();
    const start = performance.now();
    try { return checkLifecycle(); }
    finally { metric('lifecycleChecks', performance.now() - start); }
  }
  function checkLifecycle() {
    bindLifecycle();
    const first = wordsRoot?.querySelector('.word');
    observedFirst = first;
    testVisible = visible(testPanel);
    resultVisible = visible(resultPanel);
    if (session && location.pathname !== session.path) finish('abandoned');
    // Monkeytype hides typing before asynchronously revealing results. The gap is
    // not a cancellation signal, regardless of animation/calculation duration.
    if (resultVisible) {
      // Mark the known spacer once at results, avoiding body-wide CSS :has()
      // dependencies on every host letter/class/child mutation while typing.
      const ad = document.querySelector('#ad-result-wrapper');
      if (ad?.parentElement?.classList.contains('full-width')) {
        setAttributeIfChanged(ad.parentElement, 'data-keyloom-result-ad', 'true');
      }
      const info = document.querySelector('#result .stats .info .bottom');
      const text = info?.textContent ?? '';
      if (session && visible(info) && /failed\s*\(|bailed out|afk detected/i.test(text)) {
        session.abortReason = text.includes('slow timer') ? 'performance' : 'interrupted';
      }
      finish('completed');
      paint();
      return;
    }
    // Generated DOM nodes change on restart; removed first lines in timed tests do not reset index to zero.
    const readyForNewTest = testVisible && first?.getAttribute('data-wordindex') === '0' &&
      document.querySelector('#wordsInput')?.value === ' ';
    if (first && first !== firstNode && readyForNewTest) {
      queuedAdvanceId = null;
      if (firstNode) finish('abandoned');
      disabledForTest = false;
      firstNode = first;
      wordTargets = new WeakMap();
      activeWord = null;
      if (!session) status = 'Готов к тесту';
    }
    if (session && !testVisible) status = queuedAdvanceId ?
      'Следующее задание откроется после сохранения результата' : 'Ожидаю результаты';
    paint();
  }
  function queueCheck() {
    if (checkQueued) return;
    checkQueued = true;
    requestAnimationFrame(() => {
      checkQueued = false;
      check();
    });
  }
  function bindInput() {
    const nextInput = document.querySelector('#wordsInput');
    if (nextInput !== inputRoot) {
      inputRoot?.removeEventListener('beforeinput', capture, true);
      inputRoot = nextInput;
      inputRoot?.addEventListener('beforeinput', capture, true);
    }
  }
  function bindLifecycle() {
    bindInput();
    wordsRoot = document.querySelector('#words');
    testPanel = document.querySelector('#typingTest');
    resultPanel = document.querySelector('#result');
    notificationRoot = document.querySelector('[data-ui-element="notifications"]');
    const nodes = new Map();
    for (const root of [wordsRoot, testPanel, resultPanel, notificationRoot, inputRoot?.parentElement]) {
      for (let node = root; node; node = node.parentElement) nodes.set(node, 'container');
    }
    nodes.set(document.body, 'container');
    if (wordsRoot) nodes.set(wordsRoot, 'words');
    if (notificationRoot) nodes.set(notificationRoot, 'notifications');
    if (nodes.size !== observedNodes.size ||
      [...nodes].some(([node, kind]) => observedNodes.get(node) !== kind)) {
      lifecycleObserver.disconnect();
      for (const [node, kind] of nodes) {
        lifecycleObserver.observe(node, {
          childList: true,
          subtree: kind === 'notifications',
          ...(kind === 'container' ? {attributes:true, attributeOldValue:true,
            attributeFilter:['class', 'style', 'hidden']} : {})
        });
      }
      observedNodes = nodes;
    }
    // Only initial discovery needs a subtree observer. Never subscribe to the
    // stream of letter classes, extra letters and caret animation during a test.
    // Monkeytype mounts #result lazily. Waiting for it keeps the document-wide
    // observer alive through every typed letter; shallow ancestors detect its mount.
    if (wordsRoot && testPanel && inputRoot) {
      bootstrapObserver?.disconnect();
      bootstrapObserver = null;
    } else if (!bootstrapObserver) {
      bootstrapObserver = new MutationObserver(() => {
        if (!inputRoot || inputRoot.isConnected === false) bindInput();
        queueCheck();
      });
      bootstrapObserver.observe(document.body, {childList:true, subtree:true});
    }
  }
  function onLifecycleMutation(records) {
    // Rebind before the next animation frame, so a newly mounted input cannot
    // lose its first trusted keystroke while a lifecycle check is queued.
    if (!inputRoot || inputRoot.isConnected === false) bindInput();
    metric('mutationBatches');
    if (diagnostics) diagnostics.mutationRecords = (diagnostics.mutationRecords ?? 0) + records.length;
    let changed = false;
    for (const record of records) {
      if (notificationRoot?.contains(record.target)) {
        if (session && record.type === 'childList') {
          for (const node of record.addedNodes) {
            const text = node.textContent ?? '';
            const performanceAbort = text.includes('Stopping the test due to bad performance');
            if (performanceAbort || /Test failed -|Test invalid - (inconsistent test duration|AFK detected|wpm|raw|accuracy)/i.test(text)) {
              session.abortReason = performanceAbort ? 'performance' : 'interrupted';
              queuedAdvanceId = null;
              changed = true;
            }
          }
        }
        continue;
      }
      if (record.target === wordsRoot && wordsRoot.firstElementChild === observedFirst) continue;
      if (record.type === 'attributes' && record.attributeName === 'style') {
        const hiddenStyle = text => /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:;|$)/i.test(text ?? '');
        if (hiddenStyle(record.oldValue) === hiddenStyle(record.target.getAttribute('style'))) {
          continue;
        }
      }
      changed = true;
    }
    if (changed) queueCheck();
  }
  function capture(event) {
    if (event.target !== inputRoot || !event.isTrusted) return;
    metric('inputEvents');
    return captureInput(event);
  }
  function captureInput(event) {
    if (event.target?.id !== 'wordsInput' || !settings.enabled || !event.isTrusted || advancing) return;
    // Timestamp before DOM work so the adapter's own cost is not counted as
    // typing time. Layout and UI work belong to lifecycle transitions only.
    const time = Number.isFinite(event.timeStamp) && event.timeStamp > 0 ?
      event.timeStamp : performance.now();
    const replaced = wordsRoot?.firstElementChild !== observedFirst;
    if ((!session && !disabledForTest) || replaced || (session && location.pathname !== session.path)) {
      check();
    }
    if (disabledForTest) return;
    if (!testVisible || resultVisible || session?.abortReason) return;
    if (!activeWord?.classList.contains('active') || activeWord.isConnected === false) {
      metric('activeWordQueries');
      activeWord = wordsRoot?.querySelector('.word.active');
    }
    const node = activeWord;
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
      queuedAdvanceId = null;
      session = { id: crypto.randomUUID(), date: Date.now(), path: location.pathname,
        pageUrl:location.href,
        configuredSeconds:configuration.configuredSeconds, configuredWordset:configuration.configuredWordset,
        language: trainingPlan?.language ?? configuration.language ?? (/[а-яё]/iu.test(target) ? 'russian' : 'english'),
        layout: settings.layout, mode: testMode, events: [] };
      if(trainingPlan && testMode==='custom' && trainingPlan.layout===settings.layout && trainingPlan.language===session.language)session.training={id:trainingPlan.id,kind:trainingPlan.kind,targets:trainingPlan.targets,seconds:trainingPlan.seconds,...(trainingPlan.wordCount ? {wordCount:trainingPlan.wordCount} : {})};
      status = 'Записываю тест';
      paint();
    }
    if (!trainingPlan && /[а-яё]/iu.test(target)) session.language = 'russian';
    const wordIndex=Number(node.getAttribute('data-wordindex'));
    session.maxWordIndex=Math.max(session.maxWordIndex??0,wordIndex);
    if(session.training && trainingPlan.words[wordIndex]!==target)delete session.training;
    if (session.events.length >= core.MAX_EVENTS) { finish('abandoned'); disabledForTest = true; status = 'Лимит длины теста'; paint(); return; }
    session.events.push({ type: deleting ? 'delete' : 'insert', time,
      wordIndex, target,
      position: [...value.slice(1)].length, typed: event.data ?? '' });
  }
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
    lifecycleObserver = new MutationObserver(onLifecycleMutation);
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
          available:() => canQueueAdvance() || (canAdvance() && !advancing),
          canRunWhenBlocked:canQueueAdvance,
          run:requestAdvance},
        {label:'Открыть Keyloom', alias:'dashboard overview', key:'KeyO',
          run:() => pendingSave.then(() => send({type:'OPEN_DASHBOARD',sessionId:lastSavedId}))},
        {get label() {
          return todayProgress && todayProgress.done < todayProgress.total
            ? 'Продолжить сегодняшний план' : 'Составить сегодняшний план';
        }, alias:'daily plan сегодня создать продолжить',
          run:() => pendingSave.then(() => send({type:'RESUME_TODAY'}))},
        {label:'Включить диагностику', alias:'diagnostics лаги диагностика', run:startDiagnostics},
        {label:'Скачать диагностику', alias:'diagnostics export отчёт',
          available:() => Boolean(diagnostics ?? lastDiagnostics), run:downloadDiagnostics},
        {label:'Выключить диагностику', alias:'diagnostics stop',
          available:() => Boolean(diagnostics), run:() => { diagnostics = null; }}
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
    queuedAdvanceId = null;
    settings = changes.settings.newValue;
    session = null; status = settings.enabled ? 'Начните новый тест' : 'На паузе'; paint();
  });
})();
