(() => {
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const $ = id => document.getElementById(id);
  const core = KeyloomCore;
  const demo = new URLSearchParams(location.search).get('demo') === '1';
  const fixture = new URLSearchParams(location.search).get('fixture') === '1';
  const installed = !!extensionApi?.runtime?.id;
  const previewKey = fixture ? 'keyloom-fixture-v1' : 'keyloom-local-preview-v1';
  let state = { sessions: [], settings: { enabled: true, layout: 'default' } };
  let currentProfile, exercise, group = 'pairs', selectedFocus, toastTimer;
  let dailyInitialized = false;
  const analytics=KeyloomAnalytics, query=new URLSearchParams(location.search);
  let selectedSessionId=query.get('session'),activeExerciseId=query.get('exercise'),detailPage=0,detailProfile;
  if(['english','russian'].includes(query.get('language')))$('language').value=query.get('language');
  const format = (n, digits = 0) => n === null || n === undefined ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: digits });
  function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
  async function message(payload) {
    if (installed) {
      const reply = await extensionApi.runtime.sendMessage(payload);
      if (!reply?.ok) throw new Error(reply?.error ?? 'Не удалось связаться с расширением');
      return reply;
    }
    let saved;
    try { saved = JSON.parse(localStorage.getItem(previewKey) ?? 'null'); } catch { /* recover a broken preview store */ }
    saved ??= { sessions: [], settings: { enabled: true, layout: 'default' } };
    saved.learning = KeyloomLearning.ingest(saved.learning, saved.sessions);
    if (payload.type === 'GET_STATE') {
      saved.dailies = KeyloomDaily.schedule(saved.dailies ?? [], saved.dailyPrefs,
        saved.sessions, saved.settings.layout);
      localStorage.setItem(previewKey, JSON.stringify(saved));
      return saved;
    }
    if (payload.type === 'SET_SETTINGS') saved.settings = payload.settings;
    if (payload.type === 'IMPORT') {
      if (payload.layout !== undefined) {
        if (!['default','alternate'].includes(payload.layout)) throw new Error('Некорректная раскладка');
        saved.settings.layout = payload.layout;
      }
      saved.dailies = KeyloomDaily.importPlans(saved.dailies ?? [], payload.dailies);
      if (payload.dailyPrefs !== undefined) saved.dailyPrefs = KeyloomDaily.options(payload.dailyPrefs);
      saved.sessions = core.mergeSessions(saved.sessions, payload.sessions);
      saved.learning = KeyloomLearning.ingest(payload.learning ? KeyloomLearning.merge(saved.learning, payload.learning) : saved.learning, payload.sessions);
    }
    if (payload.type === 'CREATE_DAILY') {
      const plan = KeyloomDaily.create(payload.options, saved.sessions, saved.settings.layout);
      saved.dailies = KeyloomDaily.schedule([...(saved.dailies ?? []), plan].slice(-30),
        plan.prefs, saved.sessions, saved.settings.layout, Date.now(), true);
      saved.dailyPrefs = plan.prefs;
    }
    localStorage.setItem(previewKey, JSON.stringify(saved));
    return saved;
  }
  async function load() {
    try {
      state = await message({ type: 'GET_STATE' });
      if (demo) state = { sessions: KeyloomDemo.sessions(), settings: { enabled: true, layout: 'default' } };
      state.learning = KeyloomLearning.ingest(state.learning, state.sessions);
      if (!dailyInitialized) {
        setDailyFields(state.dailyPrefs ?? KeyloomDaily.options());
        dailyInitialized = true;
      }
      $('environment').textContent = demo ? 'ДЕМО' : installed ? 'РАСШИРЕНИЕ' : fixture ? 'ДАННЫЕ ТЕСТОВОГО СТЕНДА' : 'ЛОКАЛЬНЫЙ ПРЕДПРОСМОТР';
      $('demo-banner').hidden = !demo;
      $('preview-banner').hidden = demo || installed;
      $('capture-enabled').checked = state.settings.enabled;
      $('capture-enabled').disabled = demo || !installed;
      $('layout').value = state.settings.layout;
      render();
    } catch (error) { toast(error.message); KeyloomDiagnostics.report('dashboard', error); }
  }
  function filteredSessions() {
    const cutoff = $('period').value === 'all' ? 0 : Date.now() - Number($('period').value) * 86400000;
    return state.sessions.filter(s => s.date >= cutoff);
  }
  function render() {
    currentProfile = core.profile(filteredSessions(), { language: $('language').value, layout: state.settings.layout });
    $('stat-wpm').textContent = format(currentProfile.wpm);
    $('stat-accuracy').textContent = format(currentProfile.accuracy, 1);
    $('stat-minutes').textContent = currentProfile.sessions.length ? format(currentProfile.minutes, 1) : '—';
    $('stat-sessions').textContent = format(currentProfile.sessions.length);
    $('stat-samples').textContent = currentProfile.totalPresses ? `${format(currentProfile.totalPresses)} нажатий в профиле` : 'профиль ещё формируется';
    const focus = currentProfile.pairs.filter(r => r.reliable && r.score > 0).slice(0, 3);
    $('practice-title').textContent = focus.length ? 'Чуть больше внимания деталям.' : 'Начнём со знакомства.';
    $('practice-description').textContent = focus.length ? 'Эти сочетания чаще вызывают ошибки или занимают больше времени. Потренируем их в разных словах.' : 'Небольшой тест поможет увидеть твой ритм и первые сложные сочетания.';
    chips($('focus-chips'), focus.map(row => row.key));
    renderChart(); renderWeaknesses(); renderKeyboard(); renderHistory();
    $('practice-language').value=$('language').value;
    for (const choice of document.querySelectorAll('input[name="header-language"]')) {
      choice.checked = choice.value === $('language').value;
    }
    if (!exercise || exercise.language !== $('language').value || exercise.layout !== state.settings.layout) {
      $('practice-kind').value = currentCustom().kind ?? 'pairs';
      if (currentCustom().seconds) $('practice-duration').value = String(currentCustom().seconds);
      makeExercise();
    }
    renderInsights(); renderResults(); renderStatistics(); renderDaily();
  }
  function chips(container, values) {
    container.replaceChildren(...values.map(text => {
      const chip = document.createElement('span'); chip.className = 'focus-chip'; chip.textContent = text; return chip;
    }));
  }
  function empty(container, title, body, showDemo = false) {
    const div = document.createElement('div'); div.className = 'empty';
    const symbol = document.createElement('span'); symbol.className = 'empty-symbol'; symbol.textContent = '⌁';
    const heading = document.createElement('strong'); heading.textContent = title;
    const text = document.createElement('span'); text.textContent = body;
    div.append(symbol, heading, text);
    if (showDemo) { const a = document.createElement('a'); a.href = 'dashboard.html?demo=1'; a.textContent = 'Посмотреть пример с данными →'; div.append(a); }
    container.replaceChildren(div);
  }
  function renderChart(container=$('chart'), data=currentProfile.sessions, metric='wpm') {
    const sessions = data.filter(s => s.status === 'completed' && Number.isFinite(s[metric]) &&
      s[metric] >= 0 && (metric !== 'accuracy' || s[metric] <= 100) &&
      (metric === 'accuracy' || s.duration >= 5)).sort((a,b)=>a.date-b.date).slice(-24);
    const unit=metric==='wpm'?'WPM':'%';
    if (!sessions.length) return empty(container, 'Здесь появится твой прогресс', 'Нет завершённых тестов для выбранных фильтров.', true);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 620 205'); svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', `${metric==='wpm'?'Скорость':'Точность'} последних ${sessions.length} тестов: ${sessions.map(s => Math.round(s[metric])).join(', ')} ${unit}`);
    function element(tag, attrs, text) {
      const el = document.createElementNS(ns, tag);
      for (const [key, val] of Object.entries(attrs)) el.setAttribute(key, String(val));
      if (text !== undefined) el.textContent = text;
      svg.append(el); return el;
    }
    const scale = analytics.chartScale(sessions.map(s => s[metric]), metric);
    const ordinate = value => 166 - (value - scale.min) / (scale.max - scale.min) * 143;
    const points = sessions.map((s, i) => [sessions.length === 1 ? 323 : 46 + i / (sessions.length - 1) * 554, ordinate(s[metric])]);
    for (const tick of scale.ticks) {
      const y = ordinate(tick);
      element('line', { x1: 44, x2: 605, y1: y, y2: y, stroke: 'var(--border)', 'stroke-dasharray': '3 5' });
      element('text', { x: 8, y: y + 4, fill: 'var(--muted)', 'font-size': 10, 'font-family': 'JetBrains Mono,monospace' }, tick.toLocaleString('ru-RU', { maximumFractionDigits: 2 }));
    }
    if (points.length > 1) {
      element('path', { d: `M${points[0][0]},166 L${points.map(p => p.join(',')).join(' L')} L${points.at(-1)[0]},166 Z`, fill: 'var(--accent)', 'fill-opacity': .06 });
      element('polyline', { points: points.map(p => p.join(',')).join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    }
    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    tooltip.id = container.id + '-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    const hide = () => { tooltip.hidden = true; };
    function show(session, node, event) {
      tooltip.replaceChildren();
      const heading = document.createElement('strong');
      heading.textContent = new Date(session.date).toLocaleString('ru-RU');
      const details = document.createElement('div');
      details.textContent = `${format(session.wpm, 1)} WPM · ${format(session.accuracy, 1)}% точности`;
      const context = document.createElement('div');
      context.textContent = `${session.language === 'russian' ? 'Русский' : 'English'} · ${session.mode} · ${format(session.duration, 1)} с · исправлений: ${format(session.corrections)}`;
      tooltip.append(heading, details, context);
      tooltip.hidden = false;
      const rect = node.getBoundingClientRect();
      const x = event?.clientX ?? rect.right;
      const y = event?.clientY ?? rect.bottom;
      const width = tooltip.offsetWidth;
      const height = tooltip.offsetHeight;
      tooltip.style.left = Math.max(8, Math.min(x + 14, innerWidth - width - 8)) + 'px';
      tooltip.style.top = Math.max(8, y + height + 22 > innerHeight ? y - height - 14 : y + 14) + 'px';
    }
    points.forEach(([x, y], i) => {
      element('circle', { cx: x, cy: y, r: i === points.length - 1 ? 4 : 2.5, fill: 'var(--accent)', stroke: 'var(--panel)', 'stroke-width': 1.5 });
      const hit = element('circle', { cx: x, cy: y, r: 10, fill: 'transparent', tabindex: 0,
        class: 'chart-node', 'aria-describedby': tooltip.id,
        'aria-label': `${new Date(sessions[i].date).toLocaleString('ru-RU')}: ${format(sessions[i].wpm, 1)} WPM, ${format(sessions[i].accuracy, 1)}%` });
      hit.addEventListener('pointerenter', event => show(sessions[i], hit, event));
      hit.addEventListener('pointermove', event => show(sessions[i], hit, event));
      hit.addEventListener('pointerleave', hide);
      hit.addEventListener('focus', () => show(sessions[i], hit));
      hit.addEventListener('blur', hide);
      hit.addEventListener('click', event => show(sessions[i], hit, event));
      hit.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
      if (i === 0 || i === points.length - 1 || i === Math.floor(points.length / 2)) {
        element('text', { x, y: 193, 'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle', fill: 'var(--muted)', 'font-size': 10, 'font-family': 'JetBrains Mono,monospace' }, new Date(sessions[i].date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }));
      }
    });
    container.replaceChildren(svg, tooltip);
    container.onmouseleave = hide;
  }
  function table(headers) {
    const el = document.createElement('table'), thead = el.createTHead(), row = thead.insertRow();
    headers.forEach(label => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; row.append(th); });
    el.createTBody(); return el;
  }
  function cell(row, text, className) { const td = row.insertCell(); td.textContent = text; if (className) td.className = className; return td; }
  function renderWeaknesses() {
    const rows = currentProfile[group].filter(r => r.reliable).slice(0, 5);
    if (!rows.length) return empty($('weakness-table'), 'Пока собираем наблюдения', 'Несколько тестов помогут отличить случайность от закономерности.');
    const el = table([group === 'words' ? 'СЛОВО' : 'СОЧЕТАНИЕ', 'ОШИБКИ', 'ИНТЕРВАЛ, МС', 'ПОПЫТОК', '']);
    rows.forEach(item => {
      const row = el.tBodies[0].insertRow(); cell(row, item.key, 'pair-key'); cell(row, `${format(item.errorRate * 100)}%`, 'error-value');
      const timing = cell(row, item.timings.length >= 3 ? format(item.ms) : '—', 'timing');
      timing.title = `Медиана интервала между буквами в чистом вводе. ${item.timings.length} измерений. Длинные паузы и исправления исключены.`;
      cell(row, format(item.attempts), 'timing');
      const button = document.createElement('button'); button.className = 'row-train'; button.textContent = '↗'; button.title = `Тренировать ${item.key}`; button.setAttribute('aria-label', button.title);
      button.addEventListener('click', () => { selectedFocus = item.key; $('practice-kind').value=group; customProfiles.set(customKey(), {...currentCustom(), source: 'manual', targets: [item.key], kind: group}); makeExercise(); showView('practice'); });
      cell(row, '').append(button);
    });
    $('weakness-table').replaceChildren(el);
  }
  function renderKeyboard() {
    const keys = $('language').value === 'russian' ? ['йцукенгшщзх','фывапролджэ','ячсмитьбюё'] : ['qwertyuiop','asdfghjkl','zxcvbnm'];
    const stats = new Map(currentProfile.chars.map(row => [row.key, row]));
    const letters = [...keys.join('')];
    const scale = analytics.keyboardScale(letters.map(letter => stats.get(letter)));
    const levels = new Map(letters.map((letter, index) => [letter, scale.levels[index]]));
    const legend = $('keyboard-legend');
    legend.replaceChildren();
    const addLegend = (label, level) => {
      const item = document.createElement('span');
      if (level === null) item.className = 'no-data';
      else item.dataset.level = String(level);
      item.append(document.createElement('i'), document.createTextNode(label));
      legend.append(item);
    };
    addLegend('мало данных', null);
    const percent = value => (value * 100).toLocaleString('ru-RU', {minimumFractionDigits:1, maximumFractionDigits:1}) + '%';
    for (const bin of scale.bins) {
      let label = percent(bin.min) + (bin.level === 3 ? '–' : '–<') + percent(bin.max);
      if (scale.min === scale.max) label = percent(bin.min) + ' у всех';
      else if (bin.level === 3 && scale.clipped) label = 'от ' + percent(bin.min);
      addLegend(label, bin.level);
    }
    legend.title = 'Шкала по буквам с ≥5 попытками. Выбросы выше Q3 + 1,5 × IQR получают последний цвет; проценты в подсказке не изменяются.';
    $('keyboard').replaceChildren(...keys.map(text => {
      const row = document.createElement('div'); row.className = 'key-row';
      for (const letter of text) {
        const data = stats.get(letter), key = document.createElement('span'); key.className = 'key'; key.textContent = letter;
        const level = levels.get(letter);
        key.dataset.level = String(level ?? 0);
        if (level === null) key.classList.add('no-data');
        key.title = data ? `${letter}: ${data.errors} ошибок / ${data.attempts} первых попыток · ${percent(data.errorRate)}${data.attempts < 5 ? ' · мало данных' : ''}` : `${letter}: нет данных`;
        key.setAttribute('aria-label', key.title); row.append(key);
      }
      return row;
    }));
  }
  function renderHistory() {
    const sessions = state.sessions.filter(s => s.language === $('language').value && s.layout === state.settings.layout).slice().reverse();
    if (!sessions.length) return empty($('history-list'), 'История ещё впереди', 'Завершённые и прерванные тесты появятся здесь после записи.');
    const el = table(['ДАТА', 'РЕЖИМ', 'СКОРОСТЬ', 'ТОЧНОСТЬ', 'ВРЕМЯ', 'СТАТУС','']); el.className = 'history-table';
    sessions.forEach(s => {
      const row = el.tBodies[0].insertRow(); cell(row, new Date(s.date).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
      cell(row, s.mode); cell(row, `${format(s.wpm)} wpm`, 'timing'); cell(row, `${format(s.accuracy, 1)}%`, 'timing'); cell(row, `${format(s.duration)} с`, 'timing');
      cell(row, s.status === 'completed' ? 'Завершён' : 'Прерван', `history-status ${s.status}`);
      const open=document.createElement('button');open.className='row-train';open.textContent='↗';open.title='Результат теста';open.addEventListener('click',()=>{selectedSessionId=s.id;activeExerciseId=null;renderResults();showView('practice');$('workout-result').scrollIntoView({block:'center'});});cell(row,'').append(open);
    });
    const wrapper = document.createElement('div'); wrapper.className = 'history-scroll'; wrapper.append(el); $('history-list').replaceChildren(wrapper);
  }
  const practiceOptions = KeyloomPracticeOptions;
  const customProfiles = new Map();
  function customKey() {
    return $('language').value + ':' + state.settings.layout;
  }
  function defaultCustom() {
    return { source: 'auto', targets: [], ratio: .75, wordCount: null, highlight: true };
  }
  function currentCustom() {
    return customProfiles.get(customKey()) ?? defaultCustom();
  }
  function renderExerciseText() {
    const box = $('exercise-text');
    box.replaceChildren();
    exercise.words.forEach((word, index) => {
      if (index) box.append(document.createTextNode(' '));
      const span = document.createElement('span');
      span.className = 'preview-word';
      const targets = currentCustom().highlight ? exercise.targets : [];
      for (const part of practiceOptions.segments(word, targets, exercise.kind)) {
        const node = document.createElement(part.highlight ? 'mark' : 'span');
        node.textContent = part.text;
        span.append(node);
      }
      box.append(span);
    });
    $('exercise-label').textContent = currentCustom().highlight && exercise.targets.length
      ? 'ТЕКСТ ТРЕНИРОВКИ · ЦЕЛИ ВЫДЕЛЕНЫ ЦВЕТОМ' : 'ТЕКСТ ТРЕНИРОВКИ';
  }
  function practiceExtras() {
    return {
      uppercase: $('extra-uppercase').checked,
      digits: $('extra-digits').checked,
      punctuation: $('extra-punctuation').checked
    };
  }
  function makeExercise() {
    exercise = analytics.plan(state.sessions, personalWords(), {language:$('language').value,layout:state.settings.layout,seconds:Number($('practice-duration').value),kind:$('practice-kind').value,focus:selectedFocus,manualTargets:currentCustom().source==='manual'?currentCustom().targets:[],ratio:currentCustom().ratio,wordCount:currentCustom().wordCount,extras:practiceExtras()});
    $('exercise-title').textContent = exercise.reason;
    const specialMode = ['uppercase', 'digits', 'punctuation'].includes(exercise.kind);
    $('custom-ratio').disabled = specialMode;
    $('symbols-note').textContent = ['digits', 'punctuation'].includes(exercise.kind)
      ? 'Цифры и знаки: цели и средняя скорость берутся из обоих языков. Язык влияет только на буквенные упражнения.'
      : 'Заглавные — в выбранном языке. Цифры и знаки — общая статистика для всех языков.';
    $('exercise-reason').textContent = exercise.kind==='mixed'?'Обычные слова для разнообразной практики и пополнения статистики.':exercise.targeted ? 'Не меньше ' + Math.round(exercise.ratio * 100) + '% слов направлены на выбранные цели. ' + (exercise.ratio === 1 ? 'Только целевая практика.' : 'Остальные добавляют разнообразие.') : 'Пока недостаточно наблюдений для персональных рекомендаций. Начни с обычных слов — профиль сформируется по твоим результатам.';
    if (specialMode) {
      $('exercise-reason').textContent = 'Каждый фрагмент содержит цель выбранной категории. Чекбоксы позволяют добавить другие символы.';
    }
    chips($('exercise-focus'), exercise.targets);
    renderExerciseText();
    document.querySelector('.exercise .pill').textContent=`${exercise.words.length} слов · ≈ ${format(exercise.estimatedSeconds)} с`;
    $('duration-explanation').textContent=exercise.calibrating?'Пока нет измеренной скорости: расчёт по 40 WPM. После первых тестов оценка станет персональной.':`Расчёт по средней скорости последних 20 подходящих тестов: ${format(exercise.wpm,1)} WPM. Это оценка длительности, тест заканчивается после всех слов.`;
    $('practice-duration').disabled = exercise.wordCount !== null;
    if (exercise.wordCount !== null) {
      $('duration-explanation').textContent = 'Объём задан вручную: ' + exercise.wordCount + ' слов. Изменить его можно в настройках ⚙. ' + $('duration-explanation').textContent;
    }
    const meta=document.querySelector('.practice-meta');meta.replaceChildren();for(const text of [`${exercise.words.length} слов`,`≈ ${format(exercise.estimatedSeconds)} с`]){const span=document.createElement('span');span.textContent=text;meta.append(span);}
  }
  const signed=(value,digits=1)=>value===null?'—':`${value>0?'+':''}${format(value,digits)}`;
  function metricCards(container,items){container.replaceChildren(...items.map(([title,value,unit,note])=>{const card=document.createElement('article');card.className='stat';const label=document.createElement('span');label.className='stat-label';label.textContent=title;const body=document.createElement('div');const number=document.createElement('strong');number.textContent=value;const suffix=document.createElement('span');suffix.className='unit';suffix.textContent=unit;body.append(number,suffix);const small=document.createElement('small');small.textContent=note;card.append(label,body,small);return card;}));}
  function scope(options={}){return {language:$('language').value,layout:state.settings.layout,...options};}
  function renderInsights(){
    const s=analytics.summary(state.sessions,scope({days:'all'}));
    metricCards($('practice-progress'),[
      ['Серия дней',format(s.streak),'дн.',`Лучшая серия: ${s.best} · по выбранному языку`],
      ['Изменение скорости',signed(s.growth?.wpm??null),'WPM',s.growth?`${signed(s.growth.percent)}% · последние 5 против предыдущих 5`:'Нужно 10 тестов длительнее 5 секунд'],
      ['Пар и связок потренировано',format(s.practiced),'', 'Уникальные цели завершённых упражнений'],
      ['Дней с практикой',format(s.activeDays),'дн.','По сохранённым завершённым тестам'],
    ]);
  }
  function syncResultUrl(){
    const params=new URLSearchParams(location.search);
    for(const [key,value] of [['session',selectedSessionId],['exercise',activeExerciseId],['language',$('language').value]]){if(value)params.set(key,value);else params.delete(key);}
    history.replaceState(null,'',location.pathname+'?'+params.toString()+location.hash);
  }
  function renderResults(){
    const candidates=state.sessions.filter(s=>s.id===selectedSessionId||(s.language===$('language').value&&s.layout===state.settings.layout)).sort((a,b)=>b.date-a.date);
    const options=candidates.filter(s=>s.training||s.id===selectedSessionId);
    const selected=selectedSessionId?candidates.find(s=>s.id===selectedSessionId):(activeExerciseId?candidates.find(s=>s.training?.id===activeExerciseId):options[0]);
    syncResultUrl();
    const menu=$('result-selection');menu.replaceChildren();
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=activeExerciseId&&!selected?'Ожидаем результат':'Последняя тренировка';menu.append(placeholder);
    options.forEach(s=>{const option=document.createElement('option');option.value=s.id;option.textContent=`${new Date(s.date).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} · ${s.status==='completed'?'завершена':'прервана'}`;menu.append(option);});
    menu.value=selected?.id??'';
    if(selectedSessionId&&!selected)return empty($('workout-result'),'Результат не найден','Возможно, он уже вышел за пределы сохранённой истории. Выбери другую попытку.');
    if(!selected)return empty($('workout-result'),activeExerciseId?'Тренировка запущена':'Здесь будет результат твоей тренировки',activeExerciseId?'Заверши тест в Monkeytype. Результат появится здесь автоматически.':'Запусти упражнение кнопкой выше. Старые тесты без привязки доступны в истории.');
    const s=selected,box=$('workout-result');box.replaceChildren();
    const title=document.createElement('p');title.className='result-caption';title.textContent=`${s.status==='completed'?'Тренировка завершена':'Тест прерван'} · ${new Date(s.date).toLocaleString('ru-RU')} · ${s.language==='russian'?'Русский':'English'}${s.training?'':' · тест без привязки к упражнению'}`;box.append(title);
    const cards=document.createElement('div');cards.className='stats-grid result-cards';
    const errors=Object.values(s.chars).reduce((sum,r)=>sum+r.errors,0);
    metricCards(cards,[['Скорость',format(s.wpm,1),'WPM','Оценка по событиям ввода'],['Точность',format(s.accuracy,1),'%','С учётом исправленных опечаток'],['Длительность',format(s.duration,1),'с',s.training?(s.training.wordCount ? `План: ${s.training.wordCount} слов` : `План: примерно ${s.training.seconds} с`):'От первого до последнего события'],['Ошибки / исправления',`${errors} / ${s.corrections}`,'','Ошибки первого ввода / удаления']]);box.append(cards);
    const targets=s.training?.targets??[];
    if(targets.length){
      const before=core.profile(state.sessions.filter(x=>x.date<s.date),{language:s.language,layout:s.layout});
      const el=table(['ЦЕЛЬ','ПОПЫТКИ','ОШИБКИ','ИНТЕРВАЛ','К ПРЕЖНЕМУ']);
      targets.forEach(key=>{const group=s.training.kind;const stat=s[group]?.[key];const baseline=before[group].find(r=>r.key===key);const ms=stat?.timings.length>=3?core.median(stat.timings):null;const row=el.tBodies[0].insertRow();cell(row,key,'pair-key');cell(row,String(stat?.attempts??0));cell(row,stat?`${stat.errors} (${format(stat.errors/stat.attempts*100)}%)`:'—');cell(row,ms===null?'Мало данных':`${format(ms)} мс`);cell(row,ms!==null&&baseline?.timings.length>=3?`${signed(ms-baseline.ms)} мс`:'—');});
      const scroll=document.createElement('div');scroll.className='history-scroll';scroll.append(el);box.append(scroll);
    }
    const note=document.createElement('p');note.className='muted result-caption';note.textContent=targets.length?(['digits', 'punctuation'].includes(s.training?.kind) ? 'Сравнение с предыдущей историей обоих языков в этой раскладке. ' : 'Сравнение с предыдущей историей этого языка и раскладки. ') + 'Минус — быстрее. Нужно хотя бы 3 чистых измерения с каждой стороны; один тест не доказывает освоение.':'Это общий результат теста. Для сравнения конкретных слабых мест выбери тренировку пар, связок или слов.';box.append(note);
  }
  function renderStatistics(){
    const s=analytics.summary(state.sessions,scope({days:$('stats-period').value,mode:$('stats-mode').value}));
    const days = $('stats-period').value;
    const cutoff = days === 'all' ? 0 : Date.now() - Number(days) * 86400000;
    const selectedMode = $('stats-mode').value;
    detailProfile = core.profile(state.sessions.filter(session => session.date >= cutoff &&
      (selectedMode === 'all' || session.mode === selectedMode)), scope());
    $('statistics-context').textContent=`${$('language').value==='russian'?'Русский':'English'} · ${state.settings.layout==='default'?'основная':'альтернативная'} раскладка · ${s.completed.length} завершённых / ${s.selected.length-s.completed.length} прерванных`;
    metricCards($('detailed-metrics'),[
      ['Средняя скорость',format(s.mean,1),'WPM','Среднее завершённых тестов от 5 секунд'],['Лучшая скорость',format(s.bestWpm,1),'WPM','В выбранном периоде и режиме'],['Средняя точность',format(s.accuracy,1),'%','Взвешено по числу нажатий'],['Лучшая точность',format(s.bestAccuracy,1),'%','В выбранном периоде и режиме'],
      ['Завершено',format(s.completed.length),'тестов',`Всего попыток: ${s.selected.length}`],['Время практики',format(s.minutes,1),'мин','В завершённых тестах'],['Нажатия',format(s.presses),'','Печатные символы и пробелы'],['Исправления',format(s.corrections),'','События удаления, включая Backspace'],
    ]);
    renderChart($('stats-chart'),s.completed,$('stats-chart-metric').value);
    $('streak-detail').textContent=`Серия ${s.streak} · лучшая ${s.best}`;
    renderCalendar(s.all);

    renderDetailTable();
  }
  function renderCalendar(sessions) {
    const weeks = practiceOptions.calendar(sessions);
    const calendar = document.createElement('table');
    calendar.className = 'week-calendar';
    const caption = document.createElement('caption');
    caption.textContent = 'Завершённые тесты по дням недели';
    calendar.append(caption);
    const head = calendar.createTHead().insertRow();
    const corner = document.createElement('th');
    corner.scope = 'col';
    corner.textContent = 'День';
    head.append(corner);
    const dateLabel = day => new Date(day * 86400000).toLocaleDateString('ru-RU', {
      timeZone: 'UTC', day: 'numeric', month: 'short'
    });
    for (const week of weeks) {
      const heading = document.createElement('th');
      heading.scope = 'col';
      heading.textContent = dateLabel(week[0].day);
      head.append(heading);
    }
    const body = calendar.createTBody();
    ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].forEach((label, index) => {
      const row = body.insertRow();
      const heading = document.createElement('th');
      heading.scope = 'row';
      heading.textContent = label;
      row.append(heading);
      for (const week of weeks) {
        const day = week[index];
        const square = document.createElement('span');
        square.className = 'activity-day';
        square.dataset.level = String(Math.min(3, day.count));
        square.classList.toggle('future', day.future);
        square.classList.toggle('today', day.today);
        square.title = dateLabel(day.day) + (day.future ? ': будущий день' : ': ' + day.count + ' тестов');
        square.setAttribute('aria-label', square.title);
        if (!day.future) square.tabIndex = 0;
        row.insertCell().append(square);
      }
    });
    $('activity-calendar').replaceChildren(calendar);
  }
  function renderDetailTable(){
    $('detail-scope').textContent = ['digits', 'punctuation'].includes($('detail-group').value)
      ? 'Общие наблюдения из русского и английского тестов · выбранные период, режим и раскладка'
      : 'Наблюдения выбранного языка, периода, режима и раскладки';
    const rows=(detailProfile?.[$('detail-group').value]??[]).filter(r=>r.key.includes($('detail-search').value.trim().toLowerCase())).slice();
    const sort=$('detail-sort').value;rows.sort((a,b)=>(b[sort]??-1)-(a[sort]??-1)||b.attempts-a.attempts);
    const pages=Math.max(1,Math.ceil(rows.length/20));detailPage=Math.min(detailPage,pages-1);
    $('detail-prev').disabled=detailPage===0;$('detail-next').disabled=detailPage===pages-1;$('detail-page').textContent=`${detailPage+1} / ${pages} · ${rows.length} элементов`;
    if(!rows.length)return empty($('detail-table'),'Нет наблюдений','Попробуй другой язык, период или поисковый запрос.');
    const el=table(['ЭЛЕМЕНТ','ПОПЫТКИ','ОШИБКИ','ТОЧНОСТЬ','ИНТЕРВАЛ','ЗАМЕРЫ']);
    rows.slice(detailPage*20,(detailPage+1)*20).forEach(r=>{const row=el.tBodies[0].insertRow();cell(row,r.key,'pair-key');cell(row,format(r.attempts));cell(row,format(r.errors),'error-value');cell(row,`${format((1-r.errorRate)*100,1)}%`);cell(row,r.timings.length>=3?`${format(r.ms)} мс`:'Мало данных','timing');cell(row,format(r.timings.length));});
    $('detail-table').replaceChildren(el);
  }
  function personalWords() {
    return [...KeyloomWords[$('language').value],
      ...KeyloomLearning.vocabulary(state.learning, $('language').value, state.settings.layout)];
  }
  function setDailyFields(prefs) {
    $('daily-template').value = prefs.goal === 'balanced' ? 'routine' : prefs.goal;
    for (const key of ['goal','minutes','languages','kind','rounds','seconds','targets']) {
      $('daily-' + key).value = String(prefs[key]);
    }
    for (const key of ['repair','quote','repeat','numbers','punctuation']) {
      $('daily-' + key).checked = prefs[key];
    }
    updateDailyControls();
  }
  function updateDailyControls() {
    const adaptive = $('daily-goal').value === 'adaptive';
    for (const key of ['rounds', 'seconds']) $('daily-' + key).disabled = adaptive;
  }
  $('daily-goal').addEventListener('change', updateDailyControls);
  function dailyOptions() {
    const prefs = {};
    for (const key of ['goal','languages','kind','targets']) prefs[key] = $('daily-' + key).value;
    for (const key of ['minutes','rounds','seconds']) prefs[key] = Number($('daily-' + key).value);
    for (const key of ['repair','quote','repeat','numbers','punctuation']) prefs[key] = $('daily-' + key).checked;
    return KeyloomDaily.options(prefs);
  }
  function activeDaily() {
    return (state.dailies ?? []).filter(plan => plan.layout === state.settings.layout &&
      plan.day === analytics.day(Date.now())).at(-1);
  }
  function renderPlanSteps(list, plan) {
    list.replaceChildren();
    const next = plan.steps.find(step => !step.result);
    for (const step of plan.steps) {
      const item = document.createElement('li');
      item.dataset.state = step.result ? 'done' : step === next ? 'next' : 'waiting';
      item.textContent = `${step.result ? '✓ ' : ''}${step.language === 'russian' ? 'RU' : 'EN'} · ${step.label} · ≈ ${format(step.seconds / 60, 1)} мин`;
      if (step.targets?.length) item.textContent += ' · ' + step.targets.join(' · ');
      if (step.result) item.textContent += ` → ${format(step.result.wpm, 1)} WPM · ${format(step.result.accuracy, 1)}% · ${format(step.result.duration, 1)} с`;
      list.append(item);
    }
  }
  function renderDailyResults(plan) {
    const root = $('daily-history-comparison');
    const element = (tag, className, text) => {
      const node = document.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    for (const row of KeyloomDaily.results(plan)) {
      const card = element('article', 'daily-result-card');
      const header = element('header', 'daily-result-header');
      header.append(element('h3', '', row.language === 'russian' ? 'Русский' : 'English'),
        element('span', 'daily-result-state', row.done === row.total ? 'Завершено' : 'В процессе'));
      card.append(header);
      const overview = element('div', 'daily-result-overview');
      for (const [label, value] of [
        ['Задания', row.done + ' / ' + row.total],
        ['Печать', format(row.seconds / 60, 1) + ' мин'],
        ['Медиана скорости', format(row.medianWpm, 1) + ' WPM'],
        ['Лучший шаг', format(row.bestWpm, 1) + ' WPM']
      ]) {
        const metric = element('div', '');
        metric.append(element('span', 'muted', label), element('strong', '', value));
        overview.append(metric);
      }
      card.append(overview);
      const meter = element('progress', 'daily-result-progress');
      meter.max = row.total;
      meter.value = row.done;
      meter.setAttribute('aria-label', 'Выполнено заданий: ' + row.done + ' из ' + row.total);
      card.append(meter, element('h4', '', 'Один текст · до и после'));
      if (row.comparison) {
        const comparison = row.comparison;
        const grid = element('div', 'daily-result-comparison');
        for (const text of ['Показатель', 'До', 'После', 'Изменение']) {
          grid.append(element('span', 'daily-result-column', text));
        }
        const addMetric = (label, before, after, unit, higherBetter) => {
          const known = Number.isFinite(before) && Number.isFinite(after);
          // Delta uses displayed precision, so the visible numbers always agree.
          const delta = known ? Number(after.toFixed(1)) - Number(before.toFixed(1)) : null;
          const change = element('span', 'daily-result-delta', known ?
            (delta > 0 ? '+' : '') + format(delta === 0 ? 0 : delta, 1) + ' ' + unit : '—');
          if (known && Math.abs(delta) > .01) change.dataset.trend =
            (higherBetter ? delta > 0 : delta < 0) ? 'better' : 'worse';
          grid.append(element('span', '', label), element('span', '', format(before, 1)),
            element('strong', '', format(after, 1)), change);
        };
        addMetric('Время, с', comparison.before, comparison.after, 'с', false);
        addMetric('Скорость, WPM', row.beforeWpm, row.afterWpm, 'WPM', true);
        addMetric('Точность, %', comparison.beforeAccuracy, comparison.afterAccuracy, 'п.п.', true);
        card.append(grid);
      } else {
        card.append(element('p', 'muted', 'Сравнение появится после разминки и повторного текста этого языка.'));
      }
      root.append(card);
    }
    root.append(element('p', 'daily-result-footnote muted',
      'Медиана и лучший шаг учитывают разные упражнения этого плана. Сравнение до и после относится только к повторному тексту: знакомство с ним влияет на результат. Паузы не входят во время печати.'));
  }
  function renderDailyHistory() {
    const select = $('daily-history-date');
    const selected = query.get('dailyResult') || select.value || activeDaily()?.id;
    if (query.has('dailyResult')) $('daily-archive').open = true;
    query.delete('dailyResult');
    const plans = (state.dailies ?? []).filter(plan => plan.layout === state.settings.layout)
      .slice().sort((a, b) => b.date - a.date);
    select.replaceChildren();
    for (const plan of plans) {
      const option = document.createElement('option');
      option.value = plan.id;
      const date = new Date(plan.date).toLocaleString('ru-RU', {dateStyle:'short', timeStyle:'short'});
      const language = plan.prefs.languages === 'both' ? 'EN + RU' : plan.prefs.languages === 'russian' ? 'RU' : 'EN';
      option.textContent = date + ' · ' + language + ' · ' + plan.prefs.minutes + ' мин';
      select.append(option);
    }
    select.disabled = !plans.length;
    if (plans.some(plan => plan.id === selected)) select.value = selected;
    const plan = plans.find(plan => plan.id === select.value) ?? plans[0];
    $('daily-history-steps').replaceChildren();
    $('daily-history-comparison').replaceChildren();
    if (!plan) {
      $('daily-history-status').textContent = 'Сохранённых планов пока нет. Составь первый план выше.';
      return;
    }
    const completed = plan.steps.filter(step => step.result);
    const minutes = completed.reduce((sum, step) => sum + step.result.duration, 0) / 60;
    $('daily-history-status').textContent = completed.length + ' / ' + plan.steps.length +
      ' заданий выполнено · ' + format(minutes, 1) + ' мин печати';
    renderDailyResults(plan);
    renderPlanSteps($('daily-history-steps'), plan);
  }
  function renderDaily() {
    const daily = activeDaily();
    const prefs = daily?.prefs ?? state.dailyPrefs ?? KeyloomDaily.options();
    const languages = prefs.languages === 'both' ? ['english','russian'] : [prefs.languages];
    const progress = KeyloomDaily.progress(state.sessions, state.dailies ?? [], prefs, state.settings.layout);
    const today = analytics.day(Date.now());
    const done = daily?.steps.filter(step => step.result).length ?? 0;
    metricCards($('daily-progress'), [
      ['Сегодня', format(progress.minutes, 1), '/ ' + prefs.minutes + ' мин', 'Фактическая печать, выбранные языки'],
      ['Серия выполнения нормы', format(progress.streak), 'дней', 'По текущей норме и сохранённой истории'],
      ['Шаги плана', `${done} / ${daily?.steps.length ?? 0}`, '', 'Завершённые тесты из этого маршрута'],
      ['До нормы', format(Math.max(0, prefs.minutes - progress.minutes), 1), 'мин', 'Отдых и переключения не учитываются']
    ]);
    $('daily-steps').replaceChildren();
    renderDailyHistory();
    const next = daily?.steps.find(step => !step.result);
    if (daily) {
      renderPlanSteps($('daily-steps'), daily);
      const duration = daily.steps.reduce((sum, step) => sum + step.seconds, 0) / 60;
      $('daily-status').textContent = `${new Date(daily.date).toLocaleDateString('ru-RU')} · примерно ${format(duration, 1)} минут. ` +
        (next ? 'Запусти выделенный шаг. Затем нажимай «Следующее задание» прямо на Monkeytype; прогресс сохраняется автоматически.' :
          'Все шаги завершены. Если фактических минут меньше нормы, можно составить короткий дополнительный план.') +
        (daily.day !== today ? ' Это сохранённый план предыдущего дня; его можно продолжить или составить новый.' : '') +
        (!installed || demo ? ' В предпросмотре доступно планирование; запись шагов работает в установленном расширении.' : '');
    } else {
      $('daily-status').textContent = 'Выбери цель и время, затем составь план. Список шагов появится здесь до запуска тестов.';
    }
    const tomorrow = (state.dailies ?? []).find(plan => plan.layout === state.settings.layout &&
      plan.day === today + 1);
    $('daily-next-day').textContent = tomorrow ? 'Завтра: план готов · ' + tomorrow.prefs.minutes +
      ' мин. После завершения сегодняшнего занятия он обновится по новым результатам.' :
      'Сохрани программу один раз — планы на сегодня и завтра будут появляться автоматически.';
    let currentLabel = daily ? 'Сегодня всё выполнено. Результаты — в истории ниже.' :
      'Выбери программу, время и языки.';
    if (next) currentLabel = (next.language === 'russian' ? 'RU' : 'EN') + ' · ' + next.label;
    $('daily-current').textContent = currentLabel;
    $('daily-config').open = !daily;
    $('daily-start').hidden = !next;
    $('daily-start').disabled = !installed || demo;
    $('daily-start').textContent = next?.startedAt ? 'Повторно открыть текущий шаг →' : 'Начать следующий шаг →';
    $('daily-forecast').replaceChildren();
    for (const language of languages) {
      const estimate = KeyloomLearning.forecast(state.sessions, language, state.settings.layout,
        prefs.minutes / languages.length);
      const article = document.createElement('article');
      const heading = document.createElement('strong');
      heading.textContent = `${language === 'russian' ? 'Русский' : 'English'} · ${prefs.minutes / languages.length} мин/день`;
      const text = document.createElement('p');
      const reasons = {
        data: `Собираем базу: ${estimate.tests} контрольных тестов, ${estimate.days} дней. Для прогноза нужны 14 минутных time-тестов с точностью ≥95%, минимум 7 разных дней за период от 14 дней; последний — не старше недели.`,
        trend: 'Устойчивого положительного тренда пока нет. Продолжай контрольные минутные тесты: срок сейчас был бы выдумкой.',
        load: `Выбранная нагрузка сильно отличается от наблюдавшейся (${format(estimate.observedMinutes, 1)} мин/день). Сначала соберём данные при новой норме.`,
        ready: 'При сохранении похожей нагрузки и текущей динамики:'
      };
      text.textContent = (estimate.current === null ? '' : `Сейчас около ${format(estimate.current, 1)} WPM. `) + reasons[estimate.reason];
      article.append(heading, text);
      const flow = document.createElement('div');
      flow.className = 'daily-milestones';
      const current = document.createElement('span');
      current.textContent = estimate.current === null ? 'Сейчас: измеряем базу' : `Сейчас: ${format(estimate.current, 1)} WPM`;
      flow.append(current);
      if (estimate.reason !== 'ready') {
        const calibration = document.createElement('span');
        calibration.textContent = '→ Регулярные минутные контрольные тесты';
        flow.append(calibration);
        for (const value of estimate.goals) {
          const goal = document.createElement('span');
          goal.textContent = `→ ${format(value, 1)} WPM · срок появится по данным`;
          flow.append(goal);
        }
      }
      for (const milestone of estimate.milestones ?? []) {
        const point = document.createElement('span');
        point.textContent = milestone.latest > 180 ? `→ ${format(milestone.wpm, 1)} WPM: за пределами надёжного горизонта в 6 месяцев` :
          `→ ${milestone.wpm} WPM: ориентировочно ${Math.max(1, Math.ceil(milestone.earliest / 7))}–${Math.max(1, Math.ceil(milestone.latest / 7))} недель`;
        flow.append(point);
      }
      article.append(flow);

      $('daily-forecast').append(article);
    }
    const due = KeyloomLearning.due(state.learning, $('language').value, state.settings.layout);
    const repeats = $('daily-reviews');
    repeats.replaceChildren();
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = due.length ? `${due.length} целей готовы к повторению в выбранном сверху языке.` :
      'Просроченных повторений нет. После прицельных упражнений цели появятся здесь: ошибки возвращаем через день, успешные попытки — через 3, 7, 14 и 30 дней.';
    repeats.append(note);
    for (const row of due.slice(0, 12)) {
      const button = document.createElement('button');
      button.className = 'secondary';
      button.textContent = row.target + ' · повторить';
      button.addEventListener('click', () => {
        $('practice-kind').value = row.kind;
        selectedFocus = row.target;
        makeExercise();
        showView('practice');
      });
      repeats.append(button);
    }
    const transfers = KeyloomLearning.transfer(state.sessions, $('language').value, state.settings.layout);
    if (!transfers.length) {
      empty($('daily-transfer'), 'Начни с прицельной тренировки', 'Затем пройди обычный тест, чтобы проверить навык в новом контексте.');
    } else {
      const result = table(['ЦЕЛЬ','ДО / ПОСЛЕ','ОШИБКИ','ИНТЕРВАЛ']);
      for (const item of transfers) {
        const row = result.tBodies[0].insertRow();
        cell(row, item.target);
        cell(row, `${item.before.attempts} / ${item.after.attempts}`);
        cell(row, item.ready ? `${format(item.before.error * 100, 1)}% → ${format(item.after.error * 100, 1)}%` : 'Мало наблюдений');
        cell(row, item.ready && item.before.ms !== null && item.after.ms !== null ?
          `${format(item.before.ms)} → ${format(item.after.ms)} мс` : 'Мало замеров');
      }
      $('daily-transfer').replaceChildren(result);
    }
    const words = KeyloomLearning.vocabulary(state.learning, $('language').value, state.settings.layout);
    $('daily-vocabulary').textContent = `${words.length} / ${KeyloomLearning.WORD_LIMIT} слов в выбранном языке и раскладке. Слова не удаляются вместе со старыми тестами. Словарь и расписание повторений входят в JSON-экспорт; планы сохраняются локально, последние 30. Серверная синхронизация пока передаёт историю тестов, а не эти настройки.`;
    const search = $('vocabulary-search').value.trim().toLowerCase();
    chips($('vocabulary-words'), words.filter(word => word.includes(search)).slice(0, 50));
  }
  $('daily-history-date').addEventListener('change', renderDailyHistory);
  $('daily-template').addEventListener('change', () => {
    const template = $('daily-template').value;
    const prefs = KeyloomDaily.options({minutes:Number($('daily-minutes').value),
      languages:$('daily-languages').value});
    if (template === 'adaptive') Object.assign(prefs, {goal:'adaptive', kind:'auto'});
    if (template === 'routine') Object.assign(prefs, {goal:'balanced', kind:'auto'});
    if (template === 'speed') Object.assign(prefs, {goal:'speed', seconds:30, quote:false, rounds:5});
    if (template === 'accuracy') Object.assign(prefs, {goal:'accuracy', quote:false, kind:'words'});
    if (template === 'text') Object.assign(prefs, {goal:'text', kind:'punctuation', punctuation:true});
    setDailyFields(prefs);
  });
  $('daily-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('daily-error').textContent = '';
    try {
      const options = dailyOptions();
      $('daily-history-date').value = '';
      if (demo) {
        const plan = KeyloomDaily.create(options, state.sessions, state.settings.layout);
        state.dailies = KeyloomDaily.schedule([...(state.dailies ?? []), plan].slice(-30),
          plan.prefs, state.sessions, state.settings.layout, Date.now(), true);
        state.dailyPrefs = plan.prefs;
        renderDaily();
      } else {
        await message({type:'CREATE_DAILY', options});
        await load();
      }
      $('daily-config').open = false;
      toast('Новый план составлен. Можно начать первое задание.');
    } catch (error) {
      $('daily-error').textContent = error.message;
      toast(error.message);
    }
  });
  $('daily-start').addEventListener('click', async () => {
    $('daily-start').disabled = true;
    try {
      await message({type:'START_DAILY', id:activeDaily().id});
      await load();
    } catch (error) { $('daily-error').textContent = error.message; }
    finally { $('daily-start').disabled = !installed || demo; }
  });
  $('vocabulary-search').addEventListener('input', renderDaily);
  function showView(name) {
    if (!['overview','practice','daily','statistics','history','settings'].includes(name)) name = 'overview';
    document.querySelectorAll('.view').forEach(el => el.hidden = el.id !== name);
    document.querySelectorAll('[data-view]').forEach(button => {
      const active = button.dataset.view === name; button.classList.toggle('selected', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    history.replaceState(null, '', location.pathname + location.search + '#' + name);
  }
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
  document.querySelectorAll('[data-group]').forEach(button => button.addEventListener('click', () => {
    group = button.dataset.group;
    document.querySelectorAll('[data-group]').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); });
    renderWeaknesses();
  }));
  function changeLanguage(value){$('language').value=value;selectedFocus=undefined;selectedSessionId=null;activeExerciseId=null;exercise=null;detailPage=0;$('practice-kind').value=currentCustom().kind??'pairs';render();}
  $('language').addEventListener('change',()=>changeLanguage($('language').value)); $('period').addEventListener('change', render);
  $('practice-language').addEventListener('change',()=>changeLanguage($('practice-language').value));
  for (const id of ['practice-kind', 'practice-duration']) {
    $(id).addEventListener('change', () => {
      selectedFocus = undefined;
      const next = { ...currentCustom() };
      if (id === 'practice-kind') {
        next.source = 'auto';
        next.targets = [];
        next.kind = $('practice-kind').value;
      } else {
        next.wordCount = null;
        next.seconds = Number($('practice-duration').value);
      }
      customProfiles.set(customKey(), next);
      makeExercise();
    });
  }
  $('result-selection').addEventListener('change',()=>{selectedSessionId=$('result-selection').value||null;activeExerciseId=null;renderResults();});
  for(const id of ['stats-period','stats-mode','stats-chart-metric'])$(id).addEventListener('change',()=>{detailPage=0;renderStatistics();});
  for(const id of ['detail-group','detail-sort'])$(id).addEventListener('change',()=>{detailPage=0;renderDetailTable();});
  $('detail-search').addEventListener('input',()=>{detailPage=0;renderDetailTable();});
  $('detail-prev').addEventListener('click',()=>{detailPage--;renderDetailTable();});$('detail-next').addEventListener('click',()=>{detailPage++;renderDetailTable();});
  $('start-practice').addEventListener('click', () => { selectedFocus = undefined; makeExercise(); showView('practice'); });
  for (const id of ['extra-uppercase', 'extra-digits', 'extra-punctuation']) {
    $(id).addEventListener('change', makeExercise);
  }
  $('regenerate').addEventListener('click', makeExercise);
  $('launch').addEventListener('click', async () => {
    $('launch').disabled=true;
    try {
      if(installed&&!demo){await message({type:'START_PRACTICE',plan:exercise});selectedSessionId=null;activeExerciseId=exercise.id;renderResults();}
      else {window.open(KeyloomPractice.url(exercise.words,exercise.language),'_blank','noopener,noreferrer');toast('Предпросмотр: результат не привязывается. Запускай упражнение из установленного расширения.');}
    }
    catch (error) { toast(error.message); KeyloomDiagnostics.report('dashboard', error); }
    finally{$('launch').disabled=false;}
  });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(exercise.words.join(' ')); toast('Текст скопирован'); }
    catch { const range = document.createRange(); range.selectNodeContents($('exercise-text')); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); toast('Нажми Ctrl+C, чтобы скопировать текст'); }
  });
  function updateCustomFields() {
    const mixed = $('custom-kind').value === 'mixed';
    $('custom-source').disabled = mixed;
    $('custom-ratio').disabled = mixed || ['uppercase', 'digits', 'punctuation'].includes($('custom-kind').value);
    $('manual-fields').hidden = mixed || $('custom-source').value !== 'manual';
    $('custom-targets').placeholder = $('custom-kind').value === 'pairs'
      ? ($('language').value === 'russian' ? 'ст, пр, ро' : 'th, st, er')
      : ($('language').value === 'russian' ? 'скорость, строка' : 'street, rhythm');
    if ($('custom-kind').value === 'sequences') {
      $('custom-targets').placeholder = $('language').value === 'russian' ? 'стр, про, ость' : 'str, ing, ight';
    }
    const symbolPlaceholders = { uppercase: $('language').value === 'russian' ? 'А П С Т' : 'A S T R', digits: '0 1 2 3', punctuation: '. , ! ?' };
    if (symbolPlaceholders[$('custom-kind').value]) {
      $('custom-targets').placeholder = symbolPlaceholders[$('custom-kind').value];
    }
    $('target-help').textContent = ['uppercase', 'digits', 'punctuation'].includes($('custom-kind').value)
      ? 'До 12 отдельных символов. Разделяй пробелами; для пунктуации запятая тоже считается целью.'
      : 'До 12 целей через пробел или запятую. Нажми на рекомендацию, чтобы добавить или убрать её.';
    const exact = $('custom-volume').value === 'words';
    $('custom-count-label').hidden = !exact;
    $('custom-count').disabled = !exact;
    $('custom-seconds-label').hidden = exact;
    renderSuggestions();
  }
  function draftTargets() {
    const kind = $('custom-kind').value;
    const value = kind === 'uppercase' ? $('custom-targets').value.toUpperCase() : $('custom-targets').value.toLowerCase();
    return ['uppercase', 'digits', 'punctuation'].includes(kind)
      ? [...value].filter(character => !/\s/u.test(character)) : value.split(/[\s,;]+/u).filter(Boolean);
  }
  function renderSuggestions() {
    const kind = $('custom-kind').value;
    const rows = kind === 'mixed' ? [] : core.profile(state.sessions, scope())[kind].slice(0, 24);
    const selected = draftTargets();
    $('custom-suggestions').replaceChildren(...rows.map(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'target-choice';
      button.textContent = item.key;
      button.setAttribute('aria-pressed', String(selected.includes(item.key)));
      button.title = item.attempts + ' наблюдений · ' + format(item.errorRate * 100) + '% ошибок';
      button.addEventListener('click', () => {
        const targets = draftTargets();
        if (targets.includes(item.key)) {
          $('custom-targets').value = targets.filter(target => target !== item.key).join(' ');
        } else if (targets.length < 12) {
          $('custom-targets').value = [...targets, item.key].join(' ');
        } else {
          $('custom-error').textContent = 'Можно выбрать не больше 12 целей.';
        }
        renderSuggestions();
      });
      return button;
    }));
  }
  function fillCustomForm(options = currentCustom()) {
    $('custom-kind').value = $('practice-kind').value;
    $('custom-source').value = options.source;
    $('custom-targets').value = options.targets.join(' ');
    $('custom-ratio').value = String(options.ratio);
    $('custom-volume').value = options.wordCount === null ? 'time' : 'words';
    $('custom-count').value = options.wordCount ?? 40;
    $('custom-seconds').value = $('practice-duration').value;
    $('custom-highlight').checked = options.highlight;
    $('custom-error').textContent = '';
    updateCustomFields();
  }
  $('practice-customize').addEventListener('click', () => {
    fillCustomForm();
    $('practice-dialog').showModal();
  });
  for (const id of ['custom-close', 'custom-cancel']) {
    $(id).addEventListener('click', () => $('practice-dialog').close());
  }
  $('custom-reset').addEventListener('click', () => {
    fillCustomForm(defaultCustom());
    $('custom-kind').value = 'pairs';
    $('custom-seconds').value = '60';
    updateCustomFields();
  });
  $('custom-kind').addEventListener('change', () => {
    $('custom-targets').value = '';
    $('custom-error').textContent = '';
    updateCustomFields();
  });
  for (const id of ['custom-source', 'custom-volume']) {
    $(id).addEventListener('change', updateCustomFields);
  }
  $('custom-targets').addEventListener('input', renderSuggestions);
  $('practice-form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const kind = $('custom-kind').value;
      const manual = kind !== 'mixed' && $('custom-source').value === 'manual';
      const targets = manual ? practiceOptions.parseTargets($('custom-targets').value, $('language').value, kind) : [];
      if (manual && !targets.length) throw new Error('Добавь хотя бы одну цель или выбери автоматический подбор.');
      const next = {
        source: manual ? 'manual' : 'auto', targets, kind, seconds: Number($('custom-seconds').value),
        ratio: Number($('custom-ratio').value),
        wordCount: $('custom-volume').value === 'words' ? Number($('custom-count').value) : null,
        highlight: $('custom-highlight').checked
      };
      analytics.plan(state.sessions, personalWords(), {
        ...scope(), kind, seconds: Number($('custom-seconds').value),
        manualTargets: targets, ratio: next.ratio, wordCount: next.wordCount, extras: practiceExtras()
      });
      customProfiles.set(customKey(), next);
      selectedFocus = undefined;
      $('practice-kind').value = kind;
      $('practice-duration').value = $('custom-seconds').value;
      makeExercise();
      $('practice-dialog').close();
    } catch (error) {
      $('custom-error').textContent = error.message;
    }
  });
  async function saveSettings() {
    if (demo) { toast('Деморежим не меняет настройки'); $('layout').value = state.settings.layout; return; }
    try {
      const next = { enabled: $('capture-enabled').checked, layout: $('layout').value };
      await message({ type: 'SET_SETTINGS', settings: next }); state.settings = next; render(); toast('Настройки сохранены. Начни новый тест.');
    } catch (error) { toast(error.message); KeyloomDiagnostics.report('dashboard', error); }
  }
  $('capture-enabled').addEventListener('change', saveSettings); $('layout').addEventListener('change', saveSettings);
  $('export').addEventListener('click', () => {
    const data = { app: 'keyloom', version: core.VERSION, exportedAt: new Date().toISOString(), sessions: state.sessions, learning:state.learning, layout:state.settings.layout, dailies:state.dailies ?? [], dailyPrefs:state.dailyPrefs ?? KeyloomDaily.options() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `keyloom-${demo ? 'demo-' : ''}${new Date().toISOString().slice(0,10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Экспорт подготовлен');
  });
  $('import').addEventListener('change', async event => {
    try {
      if (demo) throw new Error('Вернись к своим данным для импорта');
      const file = event.target.files[0]; if (!file) return;
      if (file.size > 8_000_000) throw new Error('Файл больше 8 МБ');
      const text = await file.text();
      const sessions = core.parseBackup(text);
      const {learning, dailies, dailyPrefs, layout} = JSON.parse(text);
      if (learning && !KeyloomLearning.validate(learning)) throw new Error('Некорректный персональный словарь');
      await message({ type: 'IMPORT', sessions, learning, dailies, dailyPrefs, layout });
      dailyInitialized = false;
      await load();
      toast(`Импорт завершён: ${sessions.length} сессий, ${dailies?.length ?? 0} планов в файле.` +
        (dailies === undefined ? ' Старый экспорт не содержит планов.' : ''));
    } catch (error) { toast(error.message); KeyloomDiagnostics.report('dashboard', error); }
    finally { event.target.value = ''; }
  });
  document.querySelector('.file-button').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('import').click(); } });
  if (installed) extensionApi.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes.sessions || changes.settings || changes.syncStatus || changes.syncConfig || changes.learning || changes.dailies)) void load(); });
  else window.addEventListener('storage', () => void load());
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
  const navigate = view => {
    showView(view);
    const heading = $(view).querySelector('h1');
    if (heading) { heading.tabIndex = -1; heading.focus(); }
  };
  const commandMenu = KeyloomKeyboard.create({escape:true,hidePointer:true,commands:[
    ...[['overview','Обзор'],['practice','Прицельная практика'],['daily','Ежедневный план'],
      ['statistics','Статистика'],['history','История'],['settings','Настройки']]
      .map(([view,label]) => ({label,alias:view,run:() => navigate(view)})),
    {label:'Разогреть пальчики',alias:'warmup разминка ошибки',
      run:async () => {
        if (!installed || demo) throw new Error('Запуск разминки доступен в установленном расширении вне деморежима');
        await message({type:'START_WARMUP',language:$('language').value});
      }},
    {get label() {
      const today = KeyloomDaily.todaySummary(state.dailies ?? [], state.settings.layout);
      return today && today.done < today.total
        ? 'Продолжить сегодняшний план' : 'Составить сегодняшний план';
    },alias:'start next daily сегодня создать продолжить',
      run:async () => {
        if (!installed || demo) { navigate('daily'); return; }
        await message({type:'RESUME_TODAY'});
        await load();
      }},
    {label:'Настроить прицельную практику',alias:'custom practice',
      run:() => { showView('practice'); $('practice-customize').click(); }},
    {label:'Выбрать тему',alias:'theme appearance',run:() => {
      showView('settings'); document.querySelector('input[name="keyloom-theme"]:checked')?.focus();
    }}
  ]});
  for (const choice of document.querySelectorAll('input[name="header-language"]')) {
    choice.addEventListener('change', () => {
      if (!choice.checked) return;
      $('language').value = choice.value;
      $('language').dispatchEvent(new Event('change'));
    });
  }
  $('open-commands').addEventListener('click', commandMenu.open);
  showView(location.hash.slice(1));
  const showingDailyResult = query.has('dailyResult');
  void load().then(() => {
    if (showingDailyResult) $('daily-history-status').scrollIntoView({block:'center'});
  });
})();
