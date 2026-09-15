(() => {
  // IDs/character counts only, from Monkeytype's public quote catalog (2026-09-15).
  // Quote text is loaded and displayed by Monkeytype, never bundled here.
  const quotes = {
    english: [[719,631],[1031,697],[1072,622],[1182,902],[1223,891],[1386,618],[1477,629],[1614,705]],
    russian: [[20,661],[31,603],[35,785],[36,861],[41,803],[45,607],[93,608],[94,658]]
  };
  function options(input = {}) {
    const result = { minutes: 20, languages: 'both', goal: 'balanced', kind: 'auto', rounds: 3,
      seconds: 60, repair: true, quote: true, repeat: true, target: 80,
      numbers: false, punctuation: false, targets: '', ...input };
    if (![5,10,15,20,30,45].includes(result.minutes) ||
      !['english','russian','both'].includes(result.languages) ||
      !['balanced','speed','accuracy','text'].includes(result.goal) ||
      !['auto','pairs','sequences','words','uppercase','digits','punctuation'].includes(result.kind) ||
      !Number.isInteger(result.rounds) || result.rounds < 1 || result.rounds > 5 ||
      ![30,60,120].includes(result.seconds) || !Number.isFinite(result.target) || result.target < 10 || result.target > 300 ||
      typeof result.targets !== 'string' || result.targets.length > 300 ||
      ['repair','quote','repeat','numbers','punctuation'].some(key => typeof result[key] !== 'boolean')) {
      throw new Error('Проверьте параметры ежедневного плана');
    }
    const targets = result.targets.trim().split(/\s+/u).filter(Boolean);
    if (targets.length > 12 || (targets.length && result.kind === 'auto') ||
      targets.some(target => !KeyloomCore.validTarget(result.kind, target))) {
      throw new Error('Выберите тип целей и введите до 12 подходящих элементов через пробел');
    }
    if (!['digits','punctuation'].includes(result.kind) && targets.some(target =>
      !/^(?:[a-z]+|[а-яё]+)$/iu.test(target) ||
      (result.languages === 'english' && !/^[a-z]+$/iu.test(target)) ||
      (result.languages === 'russian' && !/^[а-яё]+$/iu.test(target)))) {
      throw new Error('Цели должны соответствовать выбранным языкам');
    }
    result.targets = [...new Set(targets.map(target =>
      result.kind === 'uppercase' ? target : target.toLowerCase()))].join(' ');
    return Object.fromEntries(Object.keys(options.defaults).map(key => [key, result[key]]));
  }
  options.defaults = { minutes:20,languages:'both',goal:'balanced',kind:'auto',rounds:3,seconds:60,
    repair:true,quote:true,repeat:true,target:80,numbers:false,punctuation:false,targets:'' };
  function create(input, sessions, layout, now = Date.now(), id = crypto.randomUUID()) {
    const prefs = options(input);
    const languages = prefs.languages === 'both' ? ['english','russian'] : [prefs.languages];
    const steps = [];
    for (const language of languages) {
      let budget = prefs.minutes * 60 / languages.length;
      const speed = KeyloomCore.profile(sessions, {language, layout}).wpm || 40;
      const add = (type, seconds, label, extra = {}) => {
        if (budget < seconds) return false;
        steps.push({id: id + '-' + steps.length, language, type, seconds, label, ...extra});
        budget -= seconds;
        return true;
      };
      if (prefs.repeat) add('review', 30, 'Повторение по расписанию');
      const quote = quotes[language][Math.abs(Math.floor(now / 86400000)) % quotes[language].length];
      const quoteSeconds = Math.max(30, Math.ceil(quote[1] / (speed * 5) * 60 / 30) * 30);
      const reserved = prefs.quote && budget >= quoteSeconds + 90 ? quoteSeconds + (prefs.repair ? 30 : 0) : 0;
      for (let round = 0; round < prefs.rounds; round++) {
        const seconds = Math.min(round === 0 ? 60 : prefs.seconds, budget - reserved - (prefs.repair ? 30 : 0));
        if (seconds < 30) break;
        const targeted = round > 0 && (prefs.kind !== 'auto' || (prefs.goal === 'accuracy' && round % 2 === 1));
        add(targeted ? 'focus' : 'time', seconds, targeted ? 'Прицельный блок' : 'Контрольный тест');
        if (prefs.repair) add('repair', 30, 'Ошибочные + медленные слова · both');
      }
      if (reserved) {
        add('quote', quoteSeconds, 'Большая цитата · quote', {quoteId:quote[0]});
        if (prefs.repair) add('repair', 30, 'Отработка цитаты · both');
      }
      while (budget >= 30) {
        const seconds = Math.min(budget, prefs.goal === 'speed' ? 30 : 60);
        const targeted = prefs.kind !== 'auto' || prefs.goal === 'accuracy';
        add(targeted ? 'focus' : 'time', seconds,
          targeted ? 'Закрепление точности' : 'Контроль переноса навыка');
      }
    }
    return {id, date:now, day:KeyloomAnalytics.day(now), layout, prefs, steps};
  }
  function exercise(daily, step, sessions, learning, dictionary, random = Math.random) {
    const prefs = daily.prefs;
    const scope = {language:step.language, layout:daily.layout};
    const profile = KeyloomCore.profile(sessions, scope);
    let kind = prefs.kind === 'auto' ? 'pairs' : prefs.kind;
    const alphabet = step.language === 'russian' ? /^[а-яё]+$/iu : /^[a-z]+$/iu;
    let targets = prefs.targets.trim().split(/\s+/u).filter(target => target &&
      (['digits','punctuation'].includes(kind) || alphabet.test(target)));
    if (step.type === 'review') {
      const due = KeyloomLearning.due(learning, step.language, daily.layout);
      const selected = due.filter(row => (prefs.kind === 'auto' || row.kind === prefs.kind) &&
        (!targets.length || targets.includes(row.target)));
      if (selected.length) {
        kind = selected[0].kind;
        targets = selected.filter(row => row.kind === kind).slice(0, 6).map(row => row.target);
      }
    } else if (step.type === 'repair') {
      kind = 'words';
      const index = daily.steps.findIndex(row => row.id === step.id);
      const previous = daily.steps.slice(0, index).reverse().find(row => row.result && row.language === step.language);
      const source = sessions.find(row => row.id === previous?.result.id);
      const words = Object.entries(source?.words ?? {});
      const median = KeyloomCore.median(words.flatMap(([, row]) => row.timings));
      targets = words.filter(([, row]) => row.errors > 0 ||
        (row.timings.length && KeyloomCore.median(row.timings) > median))
        .sort((a,b) => b[1].errors / b[1].attempts - a[1].errors / a[1].attempts).slice(0,12).map(([word]) => word);
    }
    if (!targets.length) {
      targets = profile[kind].filter(row => row.reliable && row.score > 0).slice(0, 6).map(row => row.key);
    }
    const words = [...dictionary, ...KeyloomLearning.vocabulary(learning, step.language, daily.layout)];
    const seconds = [30,60,120,180,300].reduce((best, value) =>
      Math.abs(value - step.seconds) < Math.abs(best - step.seconds) ? value : best, 30);
    return KeyloomAnalytics.plan(sessions, words, {...scope, seconds, kind, manualTargets:targets,
      ratio:prefs.goal === 'accuracy' ? 1 : .75, random,
      extras:{digits:prefs.numbers, punctuation:prefs.punctuation, uppercase:prefs.goal === 'text'}});
  }
  function nativeUrl(daily, step) {
    const settings = [step.type === 'quote' ? 'quote' : 'time',
      String(step.type === 'quote' ? step.quoteId : step.seconds), null,
      daily.prefs.punctuation, daily.prefs.numbers, step.language, 'normal', []];
    return 'https://monkeytype.com/?testSettings=' + LZString.compressToEncodedURIComponent(JSON.stringify(settings));
  }
  function complete(dailies, session, url, configuredSeconds) {
    const query = new URL(url).searchParams;
    return dailies.map(daily => {
      if (daily.id !== query.get('keyloomDaily') || daily.layout !== session.layout) return daily;
      const index = daily.steps.findIndex(step => !step.result);
      const step = daily.steps[index];
      if (!step || step.id !== query.get('keyloomStep') || !step.startedAt ||
        session.date < step.startedAt || session.status !== 'completed' || session.language !== step.language ||
        daily.steps.some(row => row.result?.id === session.id)) return daily;
      const native = ['time','quote'].includes(step.type);
      if (native && (session.mode !== step.type || session.training)) return daily;
      if (step.type === 'time' && (configuredSeconds !== undefined ?
        configuredSeconds !== step.seconds : Math.abs(session.duration - step.seconds) > 5)) return daily;
      if (!native && session.training?.id !== step.exerciseId) return daily;
      const next = structuredClone(daily);
      next.steps[index].result = {id:session.id,date:session.date,duration:session.duration,
        wpm:session.wpm,accuracy:session.accuracy};
      return next;
    });
  }
  function progress(sessions, dailies, prefs, layout, now = Date.now()) {
    const languages = prefs.languages === 'both' ? ['english','russian'] : [prefs.languages];
    const selected = sessions.filter(s => s.status === 'completed' &&
      s.layout === layout && languages.includes(s.language));
    const ledger = new Map(selected.map(s => [s.id, s]));
    for (const plan of dailies) {
      if (plan.layout !== layout) continue;
      for (const step of plan.steps) {
        if (step.result && languages.includes(step.language)) ledger.set(step.result.id, step.result);
      }
    }
    const days = new Map();
    for (const result of ledger.values()) {
      if (result.date > now) continue;
      const date = KeyloomAnalytics.day(result.date);
      days.set(date, (days.get(date) ?? 0) + result.duration / 60);
    }
    const today = KeyloomAnalytics.day(now);
    let streak = 0;
    let cursor = (days.get(today) ?? 0) >= prefs.minutes ? today : today - 1;
    while ((days.get(cursor) ?? 0) >= prefs.minutes) { streak++; cursor--; }
    return {minutes:days.get(today) ?? 0, streak};
  }
  globalThis.KeyloomDaily = Object.freeze({options, create, exercise, nativeUrl, complete, progress});
})();
