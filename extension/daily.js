(() => {
  // IDs/character counts only, from Monkeytype's public quote catalog (2026-09-15).
  // Quote text is loaded and displayed by Monkeytype, never bundled here.
  const quotes = {
    english: [[719,631],[1031,697],[1072,622],[1182,902],[1223,891],[1386,618],[1477,629],[1614,705]],
    russian: [[20,661],[31,603],[35,785],[36,861],[41,803],[45,607],[93,608],[94,658]]
  };
  const warmupTexts = {
    english: 'the morning light fills the room and a quiet day begins we open the window and listen to the wind outside there is time to notice little things and find a steady rhythm every small step helps us move forward with care',
    russian: 'утренний свет наполняет комнату и начинается тихий день мы открываем окно и слушаем ветер за окном есть время заметить простые вещи и найти спокойный ритм каждый небольшой шаг помогает двигаться вперёд без спешки и сохранять внимание к тому что происходит вокруг'
  };
  function warmupWords(language, speed) {
    const source = warmupTexts[language].split(' ');
    const budget = Math.max(10, Math.min(300, speed)) * 5 / 2;
    const words = [];
    let length = 0;
    while (words.length < 500 && (words.length < 10 || length < budget)) {
      const word = source[words.length % source.length];
      words.push(word);
      length += word.length + 1;
    }
    return words;
  }
  function options(input = {}) {
    const result = { minutes: 20, languages: 'both', goal: 'balanced', kind: 'auto', rounds: 3,
      seconds: 60, repair: true, quote: true, repeat: true,
      numbers: false, punctuation: false, targets: '', ...input };
    if (![5,10,15,20,25,30,35,45,60].includes(result.minutes) ||
      !['english','russian','both'].includes(result.languages) ||
      !['balanced','speed','accuracy','text'].includes(result.goal) ||
      !['auto','pairs','sequences','words','uppercase','digits','punctuation'].includes(result.kind) ||
      !Number.isInteger(result.rounds) || result.rounds < 1 || result.rounds > 5 ||
      ![30,60,120].includes(result.seconds) ||
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
    repair:true,quote:true,repeat:true,numbers:false,punctuation:false,targets:'' };
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
      const words = warmupWords(language, speed);
      add('warmup', 30, 'Разминка · начальный текст', {words});
      budget -= 30; // Reserve the identical closing text before optional blocks.
      if (prefs.repeat && budget >= 120) add('review', 30, 'Повторение по расписанию');
      const quote = quotes[language][Math.abs(Math.floor(now / 86400000)) % quotes[language].length];
      const quoteSeconds = Math.max(30, Math.ceil(quote[1] / (speed * 5) * 60 / 30) * 30);
      const reserved = prefs.quote && budget >= quoteSeconds + 120 ? quoteSeconds + (prefs.repair ? 60 : 0) : 0;
      for (let round = 0; round < prefs.rounds; round++) {
        const repairSeconds = prefs.repair && budget - reserved >= 120 ? 60 : 0;
        const seconds = Math.min(round === 0 ? 60 : prefs.seconds, budget - reserved - repairSeconds);
        if (seconds < 30) break;
        const targeted = round > 0 && (prefs.kind !== 'auto' || (prefs.goal === 'accuracy' && round % 2 === 1));
        add(targeted ? 'focus' : 'time', seconds, targeted ? 'Прицельный блок' : 'Контрольный тест');
        if (repairSeconds) add('repair', 60, 'Ошибочные + медленные слова · both');
      }
      if (reserved) {
        add('quote', quoteSeconds, 'Большая цитата · quote', {quoteId:quote[0]});
        if (prefs.repair) add('repair', 60, 'Отработка цитаты · both');
      }
      while (budget >= 30) {
        const seconds = Math.min(budget, prefs.goal === 'speed' ? 30 : 60);
        const targeted = prefs.kind !== 'auto' || prefs.goal === 'accuracy';
        add(targeted ? 'focus' : 'time', seconds,
          targeted ? 'Закрепление точности' : 'Контроль переноса навыка');
      }
      budget += 30;
      add('cooldown', 30, 'Повтор текста · сравнение с разминкой', {words:[...words]});
    }
    return {id, date:now, day:KeyloomAnalytics.day(now), layout, prefs, steps};
  }
  function exercise(daily, step, sessions, learning, dictionary, random = Math.random) {
    if (['warmup','cooldown'].includes(step.type)) {
      return {id:crypto.randomUUID(), date:Date.now(), language:step.language,
        layout:daily.layout, seconds:30, kind:'words', targets:[],
        words:[...step.words], wordCount:step.words.length};
    }
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
    const seconds = step.type === 'repair' ? 60 : [30,60,120,180,300].reduce((best, value) =>
      Math.abs(value - step.seconds) < Math.abs(best - step.seconds) ? value : best, 30);
    if (step.type === 'repair' && targets.length) {
      const selected = targets.filter(word => KeyloomCore.validTarget('words', word));
      if (selected.length) {
        const repeated = selected.flatMap(word => Array(2 + Math.floor(random() * 2)).fill(word));
        // Continue targeted repetitions until the text matches about one minute.
        const characterBudget = Math.max(50, (profile.wpm || 40) * 5);
        let count = repeated.join(' ').length;
        let cursor = 0;
        while ((count < characterBudget || repeated.length < 10) && repeated.length < 300) {
          const word = selected[cursor++ % selected.length];
          repeated.push(word);
          count += word.length + 1;
        }
        for (let index = repeated.length - 1; index > 0; index--) {
          const swap = Math.floor(random() * (index + 1));
          [repeated[index], repeated[swap]] = [repeated[swap], repeated[index]];
        }
        return {id:crypto.randomUUID(), date:Date.now(), ...scope, seconds, kind:'words',
          targets:selected, words:repeated, wordCount:repeated.length};
      }
    }
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
  function comparisons(daily) {
    if (!daily) return [];
    return ['english','russian'].flatMap(language => {
      const before = daily.steps.find(step => step.language === language && step.type === 'warmup');
      const after = daily.steps.find(step => step.language === language && step.type === 'cooldown');
      if (!before?.result || !after?.result ||
        JSON.stringify(before.words) !== JSON.stringify(after.words)) return [];
      return [{language, before:before.result.duration, after:after.result.duration,
        saved:before.result.duration - after.result.duration,
        beforeAccuracy:before.result.accuracy, afterAccuracy:after.result.accuracy}];
    });
  }
  function importPlans(existing, incoming) {
    if (incoming === undefined) return existing;
    const fail = () => { throw new Error('Некорректные ежедневные планы в файле'); };
    if (!Array.isArray(incoming) || incoming.length > 30 || JSON.stringify(incoming).length > 2000000) fail();
    const text = value => typeof value === 'string' && value.length > 0 && value.length <= 300;
    const number = (value, max) => Number.isFinite(value) && value >= 0 && value <= max;
    const cleaned = incoming.map(plan => {
      if (!plan || !text(plan.id) || !number(plan.date, 8640000000000000) ||
        !['default','alternate'].includes(plan.layout) || !Array.isArray(plan.steps) ||
        !plan.steps.length || plan.steps.length > 240) fail();
      const prefs = options(plan.prefs);
      const ids = new Set();
      const steps = plan.steps.map(step => {
        if (!step || !text(step.id) || ids.has(step.id) || !text(step.label) ||
          !['english','russian'].includes(step.language) ||
          !['warmup','cooldown','time','quote','repair','focus','review'].includes(step.type) ||
          !number(step.seconds, 3600) || step.seconds < 1) fail();
        ids.add(step.id);
        const row = {id:step.id, language:step.language, type:step.type, seconds:step.seconds, label:step.label};
        if (['warmup','cooldown'].includes(step.type)) {
          if (!Array.isArray(step.words) || !step.words.length || step.words.length > 300 ||
            !step.words.every(word => text(word) && KeyloomCore.supportedToken(word))) fail();
          row.words = [...step.words];
        }
        if (step.type === 'quote') {
          if (!Number.isInteger(step.quoteId) || step.quoteId < 0) fail();
          row.quoteId = step.quoteId;
        }
        if (step.targets !== undefined) {
          if (!KeyloomCore.KINDS.includes(step.kind) || !Array.isArray(step.targets) ||
            step.targets.length > 12 || !step.targets.every(target => KeyloomCore.validTarget(step.kind, target))) fail();
          row.kind = step.kind;
          row.targets = [...step.targets];
        }
        if (step.result) {
          const r = step.result;
          if (!text(r.id) || !number(r.date, 8640000000000000) || !number(r.duration, 86400) ||
            !number(r.wpm, 1000) || !number(r.accuracy, 100)) fail();
          row.result = {id:r.id,date:r.date,duration:r.duration,wpm:r.wpm,accuracy:r.accuracy};
        }
        return row;
      });
      return {id:plan.id,date:plan.date,day:KeyloomAnalytics.day(plan.date),layout:plan.layout,prefs,steps};
    });
    const merged = new Map(existing.map(plan => [plan.id, plan]));
    for (const plan of cleaned) {
      const local = merged.get(plan.id);
      if (!local) merged.set(plan.id, plan);
      else merged.set(plan.id, {...local, steps:local.steps.map(step => {
        const imported = plan.steps.find(row => row.id === step.id && row.type === step.type &&
          row.language === step.language && JSON.stringify(row.words) === JSON.stringify(step.words));
        return !step.result && imported?.result ? {...step,result:imported.result} : step;
      })});
    }
    return [...merged.values()].sort((a,b) => a.date - b.date).slice(-30);
  }
  function results(daily) {
    if (!daily) return [];
    return ['english', 'russian'].flatMap(language => {
      const steps = daily.steps.filter(step => step.language === language);
      if (!steps.length) return [];
      const completed = steps.filter(step => step.result);
      const speeds = completed.map(step => step.result.wpm).filter(Number.isFinite).sort((a, b) => a - b);
      const middle = Math.floor(speeds.length / 2);
      const medianWpm = speeds.length ? (speeds.length % 2 ? speeds[middle] :
        (speeds[middle - 1] + speeds[middle]) / 2) : null;
      const before = steps.find(step => step.type === 'warmup')?.result;
      const after = steps.find(step => step.type === 'cooldown')?.result;
      const comparison = comparisons(daily).find(row => row.language === language) ?? null;
      return [{language, done:completed.length, total:steps.length,
        seconds:completed.reduce((sum, step) => sum + (Number.isFinite(step.result.duration) ? step.result.duration : 0), 0),
        medianWpm, bestWpm:speeds.length ? speeds.at(-1) : null,
        beforeWpm:comparison && Number.isFinite(before?.wpm) ? before.wpm : null,
        afterWpm:comparison && Number.isFinite(after?.wpm) ? after.wpm : null,
        comparison}];
    });
  }
  function todaySummary(plans, layout, now = Date.now()) {
    const plan = plans.filter(row => row.day === KeyloomAnalytics.day(now) && row.layout === layout).at(-1);
    if (!plan) return null;
    const remaining = plan.steps.filter(step => !step.result);
    return {done:plan.steps.length - remaining.length, total:plan.steps.length,
      minutes:Math.ceil(remaining.reduce((sum, step) => sum + step.seconds, 0) / 60)};
  }
  globalThis.KeyloomDaily = Object.freeze({options, create, exercise, nativeUrl, complete, progress, comparisons, results, importPlans, todaySummary});
})();
