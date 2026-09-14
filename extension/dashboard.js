(() => {
  const $ = id => document.getElementById(id);
  const core = KeyloomCore;
  const demo = new URLSearchParams(location.search).get('demo') === '1';
  const fixture = new URLSearchParams(location.search).get('fixture') === '1';
  const installed = !!globalThis.chrome?.runtime?.id;
  const previewKey = fixture ? 'keyloom-fixture-v1' : 'keyloom-local-preview-v1';
  let state = { sessions: [], settings: { enabled: true, layout: 'default' } };
  let currentProfile, exercise, group = 'pairs', selectedFocus, toastTimer;
  const analytics=KeyloomAnalytics, query=new URLSearchParams(location.search);
  let selectedSessionId=query.get('session'),activeExerciseId=query.get('exercise'),detailPage=0,detailProfile;
  if(['english','russian'].includes(query.get('language')))$('language').value=query.get('language');
  const format = (n, digits = 0) => n === null || n === undefined ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: digits });
  function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
  async function message(payload) {
    if (installed) {
      const reply = await chrome.runtime.sendMessage(payload);
      if (!reply?.ok) throw new Error(reply?.error ?? 'Не удалось связаться с расширением');
      return reply;
    }
    let saved;
    try { saved = JSON.parse(localStorage.getItem(previewKey) ?? 'null'); } catch { /* recover a broken preview store */ }
    saved ??= { sessions: [], settings: { enabled: true, layout: 'default' } };
    if (payload.type === 'GET_STATE') return saved;
    if (payload.type === 'SET_SETTINGS') saved.settings = payload.settings;
    if (payload.type === 'IMPORT') saved.sessions = core.mergeSessions(saved.sessions, payload.sessions);
    localStorage.setItem(previewKey, JSON.stringify(saved));
    return saved;
  }
  async function load() {
    try {
      state = await message({ type: 'GET_STATE' });
      if (demo) state = { sessions: KeyloomDemo.sessions(), settings: { enabled: true, layout: 'default' } };
      $('environment').textContent = demo ? 'ДЕМО' : installed ? 'РАСШИРЕНИЕ' : fixture ? 'ДАННЫЕ ТЕСТОВОГО СТЕНДА' : 'ЛОКАЛЬНЫЙ ПРЕДПРОСМОТР';
      $('demo-banner').hidden = !demo;
      $('preview-banner').hidden = demo || installed;
      $('capture-enabled').checked = state.settings.enabled;
      $('capture-enabled').disabled = demo || !installed;
      $('layout').value = state.settings.layout;
      render();
    } catch (error) { toast(error.message); }
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
    if(!exercise||exercise.language!==$('language').value||exercise.layout!==state.settings.layout)makeExercise();
    renderInsights(); renderResults(); renderStatistics();
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
    const sessions = data.filter(s => metric==='accuracy'||s.duration>=5).sort((a,b)=>a.date-b.date).slice(-24);
    const unit=metric==='wpm'?'WPM':'%';
    if (!sessions.length) return empty(container, 'Здесь появится твой прогресс', 'Нет завершённых тестов для выбранных фильтров.', true);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 620 205'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${metric==='wpm'?'Скорость':'Точность'} последних ${sessions.length} тестов: ${sessions.map(s => Math.round(s[metric])).join(', ')} ${unit}`);
    function element(tag, attrs, text) {
      const el = document.createElementNS(ns, tag);
      for (const [key, val] of Object.entries(attrs)) el.setAttribute(key, String(val));
      if (text !== undefined) el.textContent = text;
      svg.append(el); return el;
    }
    const max = metric==='accuracy'?100:Math.max(20, Math.ceil(Math.max(...sessions.map(s => s.wpm)) / 20) * 20);
    const points = sessions.map((s, i) => [46 + i / Math.max(1, sessions.length - 1) * 554, 166 - s[metric] / max * 143]);
    for (let i = 0; i <= 4; i++) {
      const y = 166 - i / 4 * 143;
      element('line', { x1: 44, x2: 605, y1: y, y2: y, stroke: '#343b2e', 'stroke-dasharray': '3 5' });
      element('text', { x: 8, y: y + 4, fill: '#7f8b74', 'font-size': 10, 'font-family': 'Consolas,monospace' }, Math.round(max * i / 4));
    }
    if (points.length > 1) {
      element('path', { d: `M${points[0][0]},166 L${points.map(p => p.join(',')).join(' L')} L${points.at(-1)[0]},166 Z`, fill: '#d5e7a209' });
      element('polyline', { points: points.map(p => p.join(',')).join(' '), fill: 'none', stroke: '#d5e7a2', 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    }
    points.forEach(([x, y], i) => {
      const circle = element('circle', { cx: x, cy: y, r: i === points.length - 1 ? 4 : 2.5, fill: '#d5e7a2', stroke: '#1c1f1c', 'stroke-width': 1.5 });
      const title = document.createElementNS(ns, 'title'); title.textContent = `${new Date(sessions[i].date).toLocaleDateString('ru-RU')}: ${format(sessions[i][metric])} ${unit}`; circle.append(title);
      if (i === 0 || i === points.length - 1 || i === Math.floor(points.length / 2)) {
        element('text', { x, y: 193, 'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle', fill: '#7f8b74', 'font-size': 10, 'font-family': 'Consolas,monospace' }, new Date(sessions[i].date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }));
      }
    });
    container.replaceChildren(svg);
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
    const el = table([group === 'pairs' ? 'СОЧЕТАНИЕ' : 'СЛОВО', 'ОШИБКИ', 'ИНТЕРВАЛ, МС', 'ПОПЫТОК', '']);
    rows.forEach(item => {
      const row = el.tBodies[0].insertRow(); cell(row, item.key, 'pair-key'); cell(row, `${format(item.errorRate * 100)}%`, 'error-value');
      const timing = cell(row, item.timings.length >= 3 ? format(item.ms) : '—', 'timing');
      timing.title = `Медиана интервала между буквами в чистом вводе. ${item.timings.length} измерений. Длинные паузы и исправления исключены.`;
      cell(row, format(item.attempts), 'timing');
      const button = document.createElement('button'); button.className = 'row-train'; button.textContent = '↗'; button.title = `Тренировать ${item.key}`; button.setAttribute('aria-label', button.title);
      button.addEventListener('click', () => { selectedFocus = item.key; $('practice-kind').value=group; makeExercise(); showView('practice'); });
      cell(row, '').append(button);
    });
    $('weakness-table').replaceChildren(el);
  }
  function renderKeyboard() {
    const keys = $('language').value === 'russian' ? ['йцукенгшщзх','фывапролджэ','ячсмитьбюё'] : ['qwertyuiop','asdfghjkl','zxcvbnm'];
    const stats = new Map(currentProfile.chars.map(row => [row.key, row]));
    $('keyboard').replaceChildren(...keys.map(text => {
      const row = document.createElement('div'); row.className = 'key-row';
      for (const letter of text) {
        const data = stats.get(letter), key = document.createElement('span'); key.className = 'key'; key.textContent = letter;
        key.dataset.level = !data || data.attempts < 5 ? '0' : data.errorRate >= .15 ? '3' : data.errorRate >= .06 ? '2' : data.errorRate > 0 ? '1' : '0';
        if (!data || data.attempts < 5) key.classList.add('no-data');
        key.title = data ? `${letter}: ${data.errors} ошибок / ${data.attempts} первых попыток${data.attempts < 5 ? ' · мало данных' : ''}` : `${letter}: нет данных`;
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
  function makeExercise() {
    exercise = analytics.plan(state.sessions, KeyloomWords[$('language').value], {language:$('language').value,layout:state.settings.layout,seconds:Number($('practice-duration').value),kind:$('practice-kind').value,focus:selectedFocus});
    $('exercise-title').textContent = exercise.reason;
    $('exercise-reason').textContent = exercise.kind==='mixed'?'Обычные слова для разнообразной практики и пополнения статистики.':exercise.targeted ? 'Три слова из четырёх подбираются по выбранным слабым местам. Остальные помогают сохранить естественный ритм.' : 'Пока недостаточно наблюдений для персональных рекомендаций. Начни с обычных слов — профиль сформируется по твоим результатам.';
    chips($('exercise-focus'), exercise.targets);
    $('exercise-text').value = exercise.words.join(' ');
    document.querySelector('.exercise .pill').textContent=`${exercise.words.length} слов · ≈ ${format(exercise.estimatedSeconds)} с`;
    $('duration-explanation').textContent=exercise.calibrating?'Пока нет измеренной скорости: расчёт по 40 WPM. После первых тестов оценка станет персональной.':`Расчёт по средней скорости последних 20 подходящих тестов: ${format(exercise.wpm,1)} WPM. Это оценка длительности, тест заканчивается после всех слов.`;
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
      ['Связок потренировано',format(s.practiced),'', 'Уникальные цели завершённых упражнений'],
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
    metricCards(cards,[['Скорость',format(s.wpm,1),'WPM','Оценка по событиям ввода'],['Точность',format(s.accuracy,1),'%','С учётом исправленных опечаток'],['Длительность',format(s.duration,1),'с',s.training?`План: примерно ${s.training.seconds} с`:'От первого до последнего события'],['Ошибки / исправления',`${errors} / ${s.corrections}`,'','Буквы первого ввода / удаления']]);box.append(cards);
    const targets=s.training?.targets??[];
    if(targets.length){
      const before=core.profile(state.sessions.filter(x=>x.date<s.date),{language:s.language,layout:s.layout});
      const el=table(['ЦЕЛЬ','ПОПЫТКИ','ОШИБКИ','ИНТЕРВАЛ','К ПРЕЖНЕМУ']);
      targets.forEach(key=>{const group=s.training.kind==='words'?'words':'pairs';const stat=s[group][key];const baseline=before[group].find(r=>r.key===key);const ms=stat?.timings.length>=3?core.median(stat.timings):null;const row=el.tBodies[0].insertRow();cell(row,key,'pair-key');cell(row,String(stat?.attempts??0));cell(row,stat?`${stat.errors} (${format(stat.errors/stat.attempts*100)}%)`:'—');cell(row,ms===null?'Мало данных':`${format(ms)} мс`);cell(row,ms!==null&&baseline?.timings.length>=3?`${signed(ms-baseline.ms)} мс`:'—');});
      const scroll=document.createElement('div');scroll.className='history-scroll';scroll.append(el);box.append(scroll);
    }
    const note=document.createElement('p');note.className='muted result-caption';note.textContent=targets.length?'Интервалы сравниваются с предыдущей историей этого языка и раскладки. Минус — быстрее. Нужно хотя бы 3 чистых измерения с каждой стороны; один тест не доказывает освоение.':'Это общий результат теста. Для сравнения конкретных слабых мест выбери тренировку связок или слов.';box.append(note);
  }
  function renderStatistics(){
    const s=analytics.summary(state.sessions,scope({days:$('stats-period').value,mode:$('stats-mode').value}));
    detailProfile=core.profile(s.completed,scope());
    $('statistics-context').textContent=`${$('language').value==='russian'?'Русский':'English'} · ${state.settings.layout==='default'?'основная':'альтернативная'} раскладка · ${s.completed.length} завершённых / ${s.selected.length-s.completed.length} прерванных`;
    metricCards($('detailed-metrics'),[
      ['Средняя скорость',format(s.mean,1),'WPM','Среднее завершённых тестов от 5 секунд'],['Лучшая скорость',format(s.bestWpm,1),'WPM','В выбранном периоде и режиме'],['Средняя точность',format(s.accuracy,1),'%','Взвешено по числу нажатий'],['Лучшая точность',format(s.bestAccuracy,1),'%','В выбранном периоде и режиме'],
      ['Завершено',format(s.completed.length),'тестов',`Всего попыток: ${s.selected.length}`],['Время практики',format(s.minutes,1),'мин','В завершённых тестах'],['Нажатия',format(s.presses),'','Печатные символы и пробелы'],['Исправления',format(s.corrections),'','События удаления, включая Backspace'],
    ]);
    renderChart($('stats-chart'),s.completed,$('stats-chart-metric').value);
    $('streak-detail').textContent=`Серия ${s.streak} · лучшая ${s.best}`;
    $('activity-calendar').replaceChildren(...s.calendar.map(d=>{const square=document.createElement('div');square.className='activity-day';square.dataset.level=String(Math.min(3,d.count));const date=new Date(d.day*86400000).toLocaleDateString('ru-RU',{timeZone:'UTC',day:'numeric',month:'short'});square.title=`${date}: ${d.count} тестов`;square.setAttribute('aria-label',square.title);square.textContent=new Date(d.day*86400000).getUTCDate();return square;}));
    renderDetailTable();
  }
  function renderDetailTable(){
    const rows=(detailProfile?.[$('detail-group').value]??[]).filter(r=>r.key.includes($('detail-search').value.trim().toLowerCase())).slice();
    const sort=$('detail-sort').value;rows.sort((a,b)=>(b[sort]??-1)-(a[sort]??-1)||b.attempts-a.attempts);
    const pages=Math.max(1,Math.ceil(rows.length/20));detailPage=Math.min(detailPage,pages-1);
    $('detail-prev').disabled=detailPage===0;$('detail-next').disabled=detailPage===pages-1;$('detail-page').textContent=`${detailPage+1} / ${pages} · ${rows.length} элементов`;
    if(!rows.length)return empty($('detail-table'),'Нет наблюдений','Попробуй другой язык, период или поисковый запрос.');
    const el=table(['ЭЛЕМЕНТ','ПОПЫТКИ','ОШИБКИ','ТОЧНОСТЬ','ИНТЕРВАЛ','ЗАМЕРЫ']);
    rows.slice(detailPage*20,(detailPage+1)*20).forEach(r=>{const row=el.tBodies[0].insertRow();cell(row,r.key,'pair-key');cell(row,format(r.attempts));cell(row,format(r.errors),'error-value');cell(row,`${format((1-r.errorRate)*100,1)}%`);cell(row,r.timings.length>=3?`${format(r.ms)} мс`:'Мало данных','timing');cell(row,format(r.timings.length));});
    $('detail-table').replaceChildren(el);
  }
  function showView(name) {
    if (!['overview','practice','statistics','history','settings'].includes(name)) name = 'overview';
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
  function changeLanguage(value){$('language').value=value;selectedFocus=undefined;selectedSessionId=null;activeExerciseId=null;exercise=null;detailPage=0;render();}
  $('language').addEventListener('change',()=>changeLanguage($('language').value)); $('period').addEventListener('change', render);
  $('practice-language').addEventListener('change',()=>changeLanguage($('practice-language').value));
  for(const id of ['practice-kind','practice-duration'])$(id).addEventListener('change',()=>{selectedFocus=undefined;makeExercise();});
  $('result-selection').addEventListener('change',()=>{selectedSessionId=$('result-selection').value||null;activeExerciseId=null;renderResults();});
  for(const id of ['stats-period','stats-mode','stats-chart-metric'])$(id).addEventListener('change',()=>{detailPage=0;renderStatistics();});
  for(const id of ['detail-group','detail-sort'])$(id).addEventListener('change',()=>{detailPage=0;renderDetailTable();});
  $('detail-search').addEventListener('input',()=>{detailPage=0;renderDetailTable();});
  $('detail-prev').addEventListener('click',()=>{detailPage--;renderDetailTable();});$('detail-next').addEventListener('click',()=>{detailPage++;renderDetailTable();});
  $('start-practice').addEventListener('click', () => { selectedFocus = undefined; makeExercise(); showView('practice'); });
  $('regenerate').addEventListener('click', makeExercise);
  $('launch').addEventListener('click', async () => {
    $('launch').disabled=true;
    try {
      if(installed&&!demo){await message({type:'START_PRACTICE',plan:exercise});selectedSessionId=null;activeExerciseId=exercise.id;renderResults();}
      else {window.open(KeyloomPractice.url(exercise.words,exercise.language),'_blank','noopener,noreferrer');toast('Предпросмотр: результат не привязывается. Запускай упражнение из установленного расширения.');}
    }
    catch (error) { toast(error.message); }
    finally{$('launch').disabled=false;}
  });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('exercise-text').value); toast('Текст скопирован'); }
    catch { $('exercise-text').focus(); $('exercise-text').select(); toast('Нажми Ctrl+C, чтобы скопировать текст'); }
  });
  async function saveSettings() {
    if (demo) { toast('Деморежим не меняет настройки'); $('layout').value = state.settings.layout; return; }
    try {
      const next = { enabled: $('capture-enabled').checked, layout: $('layout').value };
      await message({ type: 'SET_SETTINGS', settings: next }); state.settings = next; render(); toast('Настройки сохранены. Начни новый тест.');
    } catch (error) { toast(error.message); }
  }
  $('capture-enabled').addEventListener('change', saveSettings); $('layout').addEventListener('change', saveSettings);
  $('export').addEventListener('click', () => {
    const data = { app: 'keyloom', version: core.VERSION, exportedAt: new Date().toISOString(), sessions: state.sessions };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `keyloom-${demo ? 'demo-' : ''}${new Date().toISOString().slice(0,10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Экспорт подготовлен');
  });
  $('import').addEventListener('change', async event => {
    try {
      if (demo) throw new Error('Вернись к своим данным для импорта');
      const file = event.target.files[0]; if (!file) return;
      if (file.size > 8_000_000) throw new Error('Файл больше 8 МБ');
      const sessions = core.parseBackup(await file.text());
      await message({ type: 'IMPORT', sessions }); await load(); toast(`Импортировано сессий: ${sessions.length}`);
    } catch (error) { toast(error.message); }
    finally { event.target.value = ''; }
  });
  document.querySelector('.file-button').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('import').click(); } });
  if (installed) chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes.sessions || changes.settings)) void load(); });
  else window.addEventListener('storage', () => void load());
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
  showView(location.hash.slice(1)); void load();
})();
