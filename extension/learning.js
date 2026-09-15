/* Durable vocabulary and review schedule; no raw keystrokes or full quote text. */
(() => {
  const DAY = 86400000;
  const WORD_LIMIT = 5000;
  const REVIEW_LIMIT = 2000;
  const WORD_BYTES = 900000;
  const wordSize = word => word.length * 3 + 4;
  const vocabularySize = value => Object.values(value).flat().reduce((sum, word) => sum + wordSize(word), 0);
  const scope = (language, layout) => language + ':' + layout;
  const reviewScope = (language, layout, kind) => scope(
    ['digits', 'punctuation'].includes(kind) ? 'shared' : language, layout);
  function empty() {
    return { version: 1, vocabulary: {}, reviews: {} };
  }
  function ingest(previous, sessions) {
    const next = structuredClone(previous ?? empty());
    let bytes = vocabularySize(next.vocabulary);
    for (const session of [...sessions].sort((a, b) => a.date - b.date)) {
      if (!KeyloomCore.validateSession(session) || session.status !== 'completed') continue;
      const key = scope(session.language, session.layout);
      const words = new Set(next.vocabulary[key] ?? []);
      const alphabet = session.language === 'russian' ? /^[а-яё]+$/u : /^[a-z]+$/u;
      for (const word of Object.keys(session.words)) {
        if (!words.has(word) && words.size < WORD_LIMIT && alphabet.test(word) && bytes + wordSize(word) <= WORD_BYTES) {
          words.add(word);
          bytes += wordSize(word);
        }
      }
      next.vocabulary[key] = [...words];
      const training = session.training;
      if (!training) continue;
      for (const target of training.targets) {
        const data = session[training.kind]?.[target];
        if (!data || data.attempts < 3) continue;
        const id = reviewScope(session.language, session.layout, training.kind) + ':' + training.kind + ':' + target;
        const old = next.reviews[id];
        // Replayed imports/sync and late deliveries cannot advance the schedule twice.
        if (old && session.date <= old.date) continue;
        if (!old && Object.keys(next.reviews).length >= REVIEW_LIMIT) continue;
        const success = data.errors / data.attempts <= .03;
        const eligible = !old || session.date >= old.due;
        let level = 0;
        if (success) level = eligible ? Math.min(4, (old?.level ?? 0) + 1) : old.level;
        next.reviews[id] = { language: session.language, layout: session.layout,
          kind: training.kind, target, date: session.date, sessionId: session.id, level,
          due: success && !eligible ? old.due : session.date + [1, 3, 7, 14, 30][level] * DAY };
      }
    }
    return next;
  }
  function vocabulary(learning, language, layout) {
    return learning?.vocabulary?.[scope(language, layout)] ?? [];
  }
  function due(learning, language, layout, now = Date.now()) {
    return Object.values(learning?.reviews ?? {}).filter(row => row.layout === layout &&
      (row.language === language || ['digits', 'punctuation'].includes(row.kind)) && row.due <= now)
      .sort((a, b) => a.due - b.due);
  }
  function transfer(sessions, language, layout) {
    const rows = sessions.filter(s => s.status === 'completed' && s.layout === layout)
      .sort((a, b) => a.date - b.date);
    const targets = new Map();
    for (const session of rows) {
      if (!session.training) continue;
      if (session.language !== language && !['digits','punctuation'].includes(session.training.kind)) continue;
      for (const target of session.training.targets) {
        targets.set(session.training.kind + ':' + target, { kind: session.training.kind, target, date: session.date });
      }
    }
    function aggregate(list, kind, target) {
      const stats = list.map(s => s[kind]?.[target]).filter(Boolean);
      const attempts = stats.reduce((sum, row) => sum + row.attempts, 0);
      const timings = stats.flatMap(row => row.timings);
      return { attempts, error: attempts ? stats.reduce((sum, row) => sum + row.errors, 0) / attempts : null,
        ms: timings.length >= 3 ? KeyloomCore.median(timings) : null };
    }
    return [...targets.values()].map(item => {
      const ordinary = rows.filter(s => !s.training && ['time', 'words', 'quote'].includes(s.mode) &&
        (s.language === language || ['digits', 'punctuation'].includes(item.kind)));
      const before = aggregate(ordinary.filter(s => s.date < item.date).slice(-20), item.kind, item.target);
      const after = aggregate(ordinary.filter(s => s.date > item.date).slice(0, 20), item.kind, item.target);
      return { ...item, before, after, ready: before.attempts >= 5 && after.attempts >= 5 };
    }).sort((a, b) => b.date - a.date).slice(0, 30);
  }
  function forecast(sessions, language, layout, minutes, now = Date.now()) {
    const rows = sessions.filter(s => s.language === language && s.layout === layout &&
      s.status === 'completed' && !s.training && s.mode === 'time' && s.duration >= 50 && s.duration <= 70 &&
      s.wpm > 0 && s.accuracy >= 95 && s.date <= now && s.date >= now - 42 * DAY).sort((a, b) => a.date - b.date);
    const days = new Map();
    for (const row of rows) {
      const day = KeyloomAnalytics.day(row.date);
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(row.wpm);
    }
    const points = [...days].map(([date, values]) => [date, KeyloomCore.median(values)]);
    const current = rows.length ? KeyloomCore.median(rows.slice(-5).map(s => s.wpm)) : null;
    const goals = current === null ? [] : [current + 5, current + 10];
    const base = { current, days: points.length, tests: rows.length, goals, minutes };
    if (points.length < 7 || rows.length < 14 || points.at(-1)[0] - points[0][0] < 13 ||
      KeyloomAnalytics.day(now) - points.at(-1)[0] > 7) return { ...base, reason: 'data' };
    const slopes = [];
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        slopes.push((points[j][1] - points[i][1]) / (points[j][0] - points[i][0]));
      }
    }
    slopes.sort((a, b) => a - b);
    const low = slopes[Math.floor(slopes.length * .25)];
    const high = slopes[Math.floor(slopes.length * .75)];
    if (low <= 0 || high <= 0) return { ...base, reason: 'trend' };
    const from = rows[0].date;
    const observedMinutes = sessions.filter(s => s.language === language && s.layout === layout &&
      s.status === 'completed' && s.date >= from && s.date <= now).reduce((sum, s) => sum + s.duration / 60, 0) /
      Math.max(1, KeyloomAnalytics.day(now) - KeyloomAnalytics.day(from) + 1);
    // No causal dose-response assumption: a different daily workload needs new observations.
    if (minutes < observedMinutes * .5 || minutes > observedMinutes * 2) {
      return { ...base, reason: 'load', observedMinutes };
    }
    const milestones = goals.map(value => ({ wpm: value,
        earliest: Math.ceil((value - current) / high), latest: Math.ceil((value - current) / low) }));
    return { ...base, observedMinutes, milestones, reason: 'ready' };
  }
  function validate(value) {
    if (!value || value.version !== 1 || !value.vocabulary || !value.reviews ||
      typeof value.vocabulary !== 'object' || typeof value.reviews !== 'object' ||
      Array.isArray(value.vocabulary) || Array.isArray(value.reviews) ||
      Object.keys(value).some(key => !['version','vocabulary','reviews'].includes(key))) return false;
    const keys = Object.keys(value.vocabulary);
    if (keys.length > 4 || Object.keys(value.reviews).length > REVIEW_LIMIT) return false;
    for (const key of keys) {
      if (!/^(english|russian):(default|alternate)$/.test(key)) return false;
      const words = value.vocabulary[key];
      const alphabet = key.startsWith('russian') ? /^[а-яё]{1,100}$/u : /^[a-z]{1,100}$/u;
      if (!Array.isArray(words) || words.length > WORD_LIMIT || words.some(word => !alphabet.test(word))) return false;
    }
    if (vocabularySize(value.vocabulary) > WORD_BYTES) return false;
    return Object.entries(value.reviews).every(([id, row]) => row &&
      Object.keys(row).every(key => ['language','layout','kind','target','date','sessionId','level','due'].includes(key)) &&
      ['english', 'russian'].includes(row.language) && ['default', 'alternate'].includes(row.layout) &&
      KeyloomCore.KINDS.includes(row.kind) && KeyloomCore.validTarget(row.kind, row.target) &&
      id === reviewScope(row.language, row.layout, row.kind) + ':' + row.kind + ':' + row.target &&
      Number.isInteger(row.level) && row.level >= 0 && row.level <= 4 &&
      Number.isFinite(row.date) && row.date >= 0 && row.date <= Date.now() + DAY &&
      Number.isFinite(row.due) && row.due >= row.date && row.due <= row.date + 30 * DAY &&
      typeof row.sessionId === 'string' && row.sessionId.length <= 100);
  }
  function merge(left, right) {
    if (!validate(right)) throw new Error('Некорректный персональный словарь');
    const result = structuredClone(left ?? empty());
    let bytes = vocabularySize(result.vocabulary);
    for (const [key, words] of Object.entries(right.vocabulary)) {
      const existing = new Set(result.vocabulary[key] ?? []);
      for (const word of words) {
        if (!existing.has(word) && existing.size < WORD_LIMIT && bytes + wordSize(word) <= WORD_BYTES) {
          existing.add(word);
          bytes += wordSize(word);
        }
      }
      result.vocabulary[key] = [...existing];
    }
    for (const [id, row] of Object.entries(right.reviews)) {
      if ((!result.reviews[id] || row.date > result.reviews[id].date) &&
        (result.reviews[id] || Object.keys(result.reviews).length < REVIEW_LIMIT)) result.reviews[id] = row;
    }
    return result;
  }
  globalThis.KeyloomLearning = Object.freeze({ empty, ingest, vocabulary, due, transfer, forecast, validate, merge, WORD_LIMIT });
})();
