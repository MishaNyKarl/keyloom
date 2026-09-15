(() => {
  function parseTargets(text, language, kind) {
    const special = ['uppercase', 'digits', 'punctuation'].includes(kind);
    const normalized = kind === 'uppercase' ? text.toUpperCase() : text.toLowerCase();
    const targets = [...new Set(special ? [...normalized].filter(character => !/\s/u.test(character)) : normalized.split(/[\s,;]+/u).filter(Boolean))];
    const alphabet = language === 'russian' ? /^[а-яё]+$/u : /^[a-z]+$/u;
    if (targets.length > 12) {
      throw new Error('Выбери не больше 12 целей за одну тренировку.');
    }
    for (const target of targets) {
      if (special) {
        if (!KeyloomCore.validTarget(kind, target) || (kind === 'uppercase' && !alphabet.test(target.toLowerCase()))) {
          throw new Error('Введите только символы выбранной категории; заглавные — на выбранном языке.');
        }
        continue;
      }
      if (!alphabet.test(target) || (kind === 'pairs' ? target.length !== 2 : kind === 'sequences' ? target.length < 3 || target.length > 5 : target.length > 40)) {
        throw new Error(kind === 'pairs'
          ? 'Пара — ровно две буквы выбранного языка, например «ст» или «th».'
          : kind === 'sequences' ? 'Связка — от 3 до 5 букв выбранного языка.' : 'Слова должны содержать только буквы выбранного языка, до 40 букв.');
      }
    }
    return targets;
  }

  // Union of matching ranges preserves overlapping pairs without nested markup.
  function segments(word, targets, kind) {
    const selected = Array(word.length).fill(false);
    const matchWord = ['uppercase', 'digits', 'punctuation'].includes(kind) ? word : word.toLowerCase();
    for (const target of targets) {
      if (kind === 'words') {
        const stripped = matchWord.replace(/^[^a-zа-яё]+|[^a-zа-яё]+$/gu, '');
        if (stripped === target) {
          const start = matchWord.indexOf(stripped);
          selected.fill(true, start, start + stripped.length);
        }
        continue;
      }
      let offset = matchWord.indexOf(target);
      while (offset !== -1) {
        selected.fill(true, offset, offset + target.length);
        offset = matchWord.indexOf(target, offset + 1);
      }
    }
    const parts = [];
    for (let i = 0; i < word.length; i++) {
      const previous = parts.at(-1);
      if (previous && previous.highlight === selected[i]) {
        previous.text += word[i];
      } else {
        parts.push({ text: word[i], highlight: selected[i] });
      }
    }
    return parts;
  }

  function calendar(sessions, now = Date.now()) {
    const today = KeyloomAnalytics.day(now);
    const weekday = (new Date(today * 86400000).getUTCDay() + 6) % 7;
    const first = today - weekday - 7 * 7;
    const counts = new Map();
    for (const session of sessions) {
      if (session.status === 'completed') {
        const date = KeyloomAnalytics.day(session.date);
        counts.set(date, (counts.get(date) ?? 0) + 1);
      }
    }
    return Array.from({ length: 8 }, (_, week) =>
      Array.from({ length: 7 }, (_, weekday) => {
        const date = first + week * 7 + weekday;
        return { day: date, count: counts.get(date) ?? 0, future: date > today, today: date === today };
      }));
  }

  globalThis.KeyloomPracticeOptions = Object.freeze({ parseTargets, segments, calendar });
})();
