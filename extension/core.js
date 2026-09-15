/* Pure analytics shared by the extension, dashboard, and tests. No DOM or network. */
(() => {
  const VERSION = 1;
  const MAX_SESSIONS = 160;
  const MAX_EVENTS = 18000;
  const MAX_STORAGE_BYTES = 6_000_000;
  const PAUSE_MS = 2000;
  const median = values => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const entry = (map, key) => map[key] ??= { attempts: 0, errors: 0, timings: [] };
  const normalize = word => word.normalize('NFC').toLocaleLowerCase();
  const alphabetic = text => /^[a-zа-яё]+$/iu.test(text);
  const PUNCTUATION = '.,!?;:-—–…\'"«»“”‘’()[]{}/%+*=<>_\\@#$&|~^`№';
  const KINDS = ['pairs', 'sequences', 'words', 'mixed', 'uppercase', 'digits', 'punctuation'];
  function characterGroup(character) {
    if (/^[A-ZА-ЯЁ]$/u.test(character)) return 'uppercase';
    if (/^[0-9]$/u.test(character)) return 'digits';
    if (character.length === 1 && PUNCTUATION.includes(character)) return 'punctuation';
    return null;
  }
  function supportedToken(text) {
    return typeof text === 'string' && text.length > 0 && text.length <= 100 &&
      [...text].every(character => alphabetic(character) || characterGroup(character));
  }
  function validTarget(kind, text) {
    if (typeof text !== 'string') return false;
    if (['uppercase', 'digits', 'punctuation'].includes(kind)) return characterGroup(text) === kind;
    if (!alphabetic(text)) return false;
    if (kind === 'pairs') return text.length === 2;
    if (kind === 'sequences') return text.length >= 3 && text.length <= 5;
    return text.length <= 100;
  }

  function analyze(events, metadata = {}) {
    const chars = Object.create(null), pairs = Object.create(null), sequences = Object.create(null), words = Object.create(null);
    const special = { uppercase: Object.create(null), digits: Object.create(null), punctuation: Object.create(null) };
    function observeSpecial(character, error, timing) {
      const group = characterGroup(character);
      if (!group) return;
      const row = entry(special[group], character);
      row.attempts++;
      row.errors += Number(error);
      if (Number.isFinite(timing)) row.timings.push(timing);
    }
    const instances = new Map();
    let previous = null, presses = 0, correct = 0, corrections = 0;
    let start = null, end = 0;
    for (const e of events.slice(0, MAX_EVENTS)) {
      if (!Number.isFinite(e.time) || !Number.isInteger(e.position) || typeof e.target !== 'string') continue;
      start ??= e.time;
      end = Math.max(end, e.time);
      let word = instances.get(e.wordIndex);
      if (!word) {
        word = { edges: new Map(), target: e.target, seen: new Set(), firstErrors: new Set(), first: null, last: null, errors: 0, dirty: false, complete: false, timings: [] };
        instances.set(e.wordIndex, word);
      }
      if (e.type === 'delete') {
        corrections++;
        word.dirty = true;
        previous = null;
        continue;
      }
      if (e.type === 'break') { previous = null; word.dirty = true; continue; }
      if (e.type !== 'insert' || typeof e.typed !== 'string' || [...e.typed].length !== 1) continue;
      const target = [...word.target];
      const isCommit = e.typed === ' ';
      if (isCommit && e.position === 0) { previous = null; continue; }
      presses++;
      const expected = isCommit && e.position >= target.length ? ' ' : (target[e.position] ?? '');
      const isCorrect = e.typed === expected;
      if (isCorrect) correct++;
      else { word.errors++; word.dirty = true; }

      if (isCommit) {
        // A skipped letter is a first-pass failure, even though there was no keypress.
        for (let p = 0; p < target.length; p++) {
          if (word.seen.has(p)) continue;
          word.seen.add(p);
          word.firstErrors.add(p);
          const c = entry(chars, normalize(target[p])); c.attempts++; c.errors++;
          observeSpecial(target[p], true);
          if (p > 0 && alphabetic(target.slice(p - 1, p + 1).join(''))) {
            const pair = entry(pairs, normalize(target.slice(p - 1, p + 1).join('')));
            pair.attempts++; pair.errors++;
          }
          word.errors++; word.dirty = true;
        }
        word.complete = true;
        previous = null;
        continue;
      }

      const firstPass = !word.seen.has(e.position);
      const elapsed = previous ? e.time - previous.time : null;
      const cleanTransition = firstPass && isCorrect && previous?.correct && previous.firstPass &&
        previous.wordIndex === e.wordIndex && previous.position === e.position - 1 &&
        elapsed >= 10 && elapsed <= PAUSE_MS;
      if (cleanTransition) word.edges.set(e.position, elapsed);
      if (previous && elapsed > PAUSE_MS) word.dirty = true;
      word.first ??= e.time;
      word.last = e.time;
      if (firstPass && expected) {
        word.seen.add(e.position);
        if (!isCorrect) word.firstErrors.add(e.position);
        const c = entry(chars, normalize(expected)); c.attempts++; c.errors += Number(!isCorrect);
        observeSpecial(expected, !isCorrect, cleanTransition ? elapsed : undefined);
        if (e.position > 0) {
          const key = normalize(target.slice(e.position - 1, e.position + 1).join(''));
          if (alphabetic(key)) {
            const pair = entry(pairs, key); pair.attempts++; pair.errors += Number(!isCorrect || word.firstErrors.has(e.position - 1));
            if (cleanTransition) { pair.timings.push(elapsed); c.timings.push(elapsed); word.timings.push(elapsed); }
          }
        }
      }
      if (e.position === target.length - 1) word.complete = true;
      previous = { ...e, correct: isCorrect, firstPass };
    }
    for (const word of instances.values()) {
      for (let length = 3; length <= 5; length++) {
        for (let start = 0; start + length <= word.target.length; start++) {
          const positions = Array.from({ length }, (_, index) => start + index);
          if (!positions.every(position => word.seen.has(position))) continue;
          const key = normalize(word.target.slice(start, start + length));
          if (!alphabetic(key)) continue;
          const row = entry(sequences, key);
          row.attempts++;
          row.errors += Number(positions.some(position => word.firstErrors.has(position)));
          const edges = positions.slice(1).map(position => word.edges.get(position));
          if (!positions.some(position => word.firstErrors.has(position)) && edges.every(Number.isFinite)) {
            row.timings.push(edges.reduce((sum, value) => sum + value, 0) / edges.length);
          }
        }
      }
      // Partial final words do contribute observed characters, but not whole-word accuracy.
      const lexical = word.target.replace(/^[^a-zа-яё]+|[^a-zа-яё]+$/giu, '');
      if (!word.complete || !alphabetic(lexical)) continue;
      const w = entry(words, normalize(lexical));
      w.attempts++; w.errors += Number(word.errors > 0);
      if (!word.dirty && word.timings.length === [...word.target].length - 1 && word.timings.length) {
        w.timings.push((word.last - word.first) / word.timings.length);
      }
    }
    const duration = Math.max(0, (end - (start ?? 0)) / 1000);
    return {
      id: metadata.id ?? crypto.randomUUID(), date: metadata.date ?? Date.now(),
      language: metadata.language ?? 'english', layout: metadata.layout ?? 'default',
      mode: metadata.mode ?? 'unknown', status: metadata.status ?? 'completed',
      source: metadata.source ?? 'monkeytype-dom-v1', duration, presses, corrections,
      accuracy: presses ? correct / presses * 100 : 0,
      wpm: duration > 0 ? correct / 5 / (duration / 60) : 0,
      chars, pairs, sequences, words, ...special,
      ...(metadata.training ? { training: metadata.training } : {}),
    };
  }

  function profile(sessions, { language = 'english', layout = 'default' } = {}) {
    const selected = sessions.filter(s => s.language === language && s.layout === layout && s.status === 'completed');
    const groups = { chars: Object.create(null), pairs: Object.create(null), sequences: Object.create(null), words: Object.create(null), uppercase: Object.create(null), digits: Object.create(null), punctuation: Object.create(null) };
    for (const session of sessions.filter(s => s.layout === layout && s.status === 'completed')) {
      for (const group of Object.keys(groups)) {
        if (session.language !== language && !['digits', 'punctuation'].includes(group)) continue;
        for (const [key, value] of Object.entries(session[group] ?? {})) {
          if (group === 'chars' && !alphabetic(key)) continue;
          const row = entry(groups[group], key);
          row.attempts += value.attempts;
          row.errors += value.errors;
          row.timings.push(...value.timings);
        }
      }
    }
    const baseline = median(Object.values(groups.pairs).flatMap(v => v.timings)) ?? 180;
    for (const group of Object.keys(groups)) {
      const groupBaseline = ['digits', 'punctuation'].includes(group)
        ? median(Object.values(groups[group]).flatMap(value => value.timings)) ?? 180 : baseline;
      groups[group] = Object.entries(groups[group]).map(([key, value]) => {
        const ms = median(value.timings);
        // Shrink tiny samples; timing only affects priority after three clean observations.
        const errorRate = value.errors / Math.max(1, value.attempts);
        const slow = value.timings.length >= 3 && ms ? Math.max(0, ms / groupBaseline - 1) : 0;
        const confidence = value.attempts / (value.attempts + 8);
        return { key, ...value, ms, errorRate, confidence,
          reliable: value.attempts >= 5,
          score: confidence * (errorRate * 3 + slow) };
      }).sort((a, b) => b.score - a.score || b.attempts - a.attempts || a.key.localeCompare(b.key));
    }
    const totalPresses = selected.reduce((sum, s) => sum + s.presses, 0);
    return { ...groups, sessions: selected, baseline, totalPresses,
      accuracy: totalPresses ? selected.reduce((sum, s) => sum + s.accuracy * s.presses, 0) / totalPresses : null,
      wpm: median(selected.filter(s => s.duration >= 5).map(s => s.wpm)),
      minutes: selected.reduce((sum, s) => sum + s.duration, 0) / 60 };
  }

  function generate(profile, dictionary, { count = 40, random = Math.random, focus, ratio = .75, targets: explicitTargets } = {}) {
    const targets = explicitTargets ?? (focus ? [focus] : profile.pairs.filter(r => r.reliable && r.score > 0).slice(0, 3).map(r => r.key));
    const weakWords = profile.words.filter(r => r.reliable && r.score > 0).slice(0, 12).map(r => r.key);
    const pool = [...new Set([...dictionary, ...weakWords])].filter(alphabetic);
    const targeted = pool.filter(word => targets.some(pair => word.includes(pair)) || weakWords.includes(word));
    const picked = [];
    const limit = Math.min(1000, Math.max(10, Math.round(count)));
    for (let i = 0; i < limit; i++) {
      const useTarget = Math.ceil((i + 1) * ratio) > Math.ceil(i * ratio);
      const source = targeted.length && useTarget ? targeted : pool;
      const candidates = source.filter(w => w !== picked.at(-1));
      const choices = candidates.length ? candidates : source;
      if (!choices.length) break;
      picked.push(choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))]);
    }
    return { words: picked, targets, targeted: targeted.length > 0,
      reason: targeted.length ? 'Прицельная практика' : 'Калибровка навыка' };
  }

  function validateSession(s) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || s.id.length > 100) return false;
    if (!['english', 'russian'].includes(s.language) || !['default', 'alternate'].includes(s.layout)) return false;
    if (!['completed', 'abandoned'].includes(s.status)) return false;
    if (!Number.isFinite(s.date) || s.date < 0 || s.date > Date.now() + 86400000) return false;
    if (!['time','words','custom','quote','unknown'].includes(s.mode)) return false;
    if (typeof s.source !== 'string' || s.source.length > 80) return false;
    if(s.training!==undefined){const t=s.training;
      if (t?.wordCount !== undefined && (!Number.isInteger(t.wordCount) || t.wordCount < 10 || t.wordCount > 500)) return false;
      if(!t||typeof t.id!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(t.id)||!KINDS.includes(t.kind)||![30,60,120,180,300].includes(t.seconds)||!Array.isArray(t.targets)||t.targets.length>12||!t.targets.every(k=>validTarget(t.kind,k)))return false;
    }
    for (const key of ['duration', 'presses', 'corrections', 'accuracy', 'wpm']) {
      if (!Number.isFinite(s[key]) || s[key] < 0) return false;
    }
    if (s.duration > 86400 || s.presses > MAX_EVENTS || s.accuracy > 100 || s.wpm > 100000) return false;
    for (const group of ['chars', 'pairs', 'sequences', 'words', 'uppercase', 'digits', 'punctuation']) {
      if (['sequences', 'uppercase', 'digits', 'punctuation'].includes(group) && s[group] === undefined) continue;
      if (!s[group] || typeof s[group] !== 'object' || Array.isArray(s[group])) return false;
      const entries = Object.entries(s[group]);
      if (entries.length > MAX_EVENTS) return false;
      for (const [key, v] of entries) {
        if (group === 'sequences' && (key.length < 3 || key.length > 5 || !alphabetic(key))) return false;
        if (['uppercase', 'digits', 'punctuation'].includes(group) && characterGroup(key) !== group) return false;
        if (!key || key.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(key)) return false;
        if (!v || !Number.isInteger(v.attempts) || v.attempts < 1 || v.attempts > MAX_EVENTS) return false;
        if (!Number.isInteger(v.errors) || v.errors < 0 || v.errors > v.attempts) return false;
        if (!Array.isArray(v.timings) || v.timings.length > MAX_EVENTS || !v.timings.every(t => Number.isFinite(t) && t >= 0 && t <= PAUSE_MS)) return false;
      }
    }
    return true;
  }
  function mergeSessions(existing, incoming) {
    if (!Array.isArray(incoming) || incoming.length > MAX_SESSIONS || !incoming.every(validateSession)) throw new Error('Некорректный формат сессий');
    const unique = new Map(existing.map(s => [s.id, s]));
    for (const s of incoming) unique.set(s.id, s);
    const sorted = [...unique.values()].sort((a, b) => b.date - a.date).slice(0, MAX_SESSIONS);
    let bytes = 0;
    const kept = [];
    for (const session of sorted) {
      const size = new TextEncoder().encode(JSON.stringify(session)).length;
      if (size > MAX_STORAGE_BYTES) throw new Error('Сессия превышает лимит хранилища');
      if (bytes + size > MAX_STORAGE_BYTES) break;
      bytes += size; kept.push(session);
    }
    return kept.reverse();
  }
  function parseBackup(text) {
    if (text.length > 8_000_000) throw new Error('Файл больше 8 МБ');
    const data = JSON.parse(text);
    if (data?.version !== VERSION || data?.app !== 'keyloom') throw new Error('Нужен файл экспорта Keyloom v1');
    return mergeSessions([], data.sessions);
  }
  globalThis.KeyloomCore = Object.freeze({ VERSION, MAX_SESSIONS, MAX_EVENTS, MAX_STORAGE_BYTES, PAUSE_MS, PUNCTUATION, KINDS, characterGroup, supportedToken, validTarget, median, analyze, profile, generate, validateSession, mergeSessions, parseBackup });
})();
