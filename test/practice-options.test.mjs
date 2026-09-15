import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
const context = vm.createContext({ crypto: webcrypto, TextEncoder });
for (const name of ['core', 'analytics', 'practice-options', 'words']) {
  vm.runInContext(await readFile(new URL(`../extension/${name}.js`, import.meta.url), 'utf8'), context);
}
const options = context.KeyloomPracticeOptions;
const analytics = context.KeyloomAnalytics;
const dictionary = context.KeyloomWords;
const plain = value => JSON.parse(JSON.stringify(value));

test('manual goals normalize separators and reject mixed languages, long pairs and too many goals', () => {
  assert.deepEqual(plain(options.parseTargets('СТ, пр; ст\nро', 'russian', 'pairs')), ['ст', 'пр', 'ро']);
  assert.throws(() => options.parseTargets('ст th', 'russian', 'pairs'));
  assert.throws(() => options.parseTargets('str', 'english', 'pairs'));
  assert.throws(() => options.parseTargets('a b c d e f g h i j k l m', 'english', 'words'));
});

test('highlight preserves text and unions overlapping pairs; words match exactly', () => {
  assert.deepEqual(plain(options.segments('строка', ['ст', 'тр'], 'pairs')), [
    { text: 'стр', highlight: true }, { text: 'ока', highlight: false }
  ]);
  assert.deepEqual(plain(options.segments('there', ['he'], 'words')), [{ text: 'there', highlight: false }]);
  assert.equal(options.segments('there', ['there'], 'words')[0].highlight, true);
  assert.equal(options.segments('banana', ['an'], 'pairs').map(part => part.text).join(''), 'banana');
});

test('calendar has Monday-first weekday rows, chronological weeks and blank future days', () => {
  const now = new Date(2026, 8, 15, 12).getTime();
  const weeks = options.calendar([
    { date: now, status: 'completed' }, { date: now, status: 'completed' },
    { date: now, status: 'abandoned' }
  ], now);
  assert.equal(weeks.length, 8);
  assert.ok(weeks.every(week => week.length === 7));
  assert.equal(new Date(weeks[0][0].day * 86400000).getUTCDay(), 1);
  assert.equal(weeks[7][1].count, 2);
  assert.equal(weeks[7][1].today, true);
  assert.equal(weeks[7][2].future, true);
  assert.equal(weeks[7][0].day - weeks[0][0].day, 49);
  const sunday = options.calendar([], new Date(2026, 8, 20, 12).getTime());
  assert.equal(sunday.flat().filter(day => day.future).length, 0);
});

test('manual pairs beyond the automatic top three are used; count and density are respected', () => {
  const targets = ['st', 'th', 'er', 'in'];
  const p = analytics.plan([], dictionary.english, {
    manualTargets: targets, wordCount: 31, ratio: 1, random: () => .7
  });
  assert.deepEqual(plain(p.targets), targets);
  assert.equal(p.words.length, 31);
  assert.ok(p.words.every(word => targets.some(target => word.includes(target))));
  assert.ok(analytics.validPlan(p));
  const half = analytics.plan([], ['street', 'world'], {
    manualTargets: ['st'], wordCount: 11, ratio: .5, random: () => .9
  });
  assert.ok(half.words.filter(word => word.includes('st')).length >= 6);
});

test('custom words outside the dictionary are trainable without invented pair matches', () => {
  const p = analytics.plan([], dictionary.english, {
    kind: 'words', manualTargets: ['keyloom'], wordCount: 10, ratio: 1
  });
  assert.ok(p.words.every(word => word === 'keyloom'));
  assert.deepEqual(plain(p.targets), ['keyloom']);
  assert.throws(() => analytics.plan([], ['street'], { manualTargets: ['zz'] }), /нет слов/);
  assert.throws(() => analytics.plan([], dictionary.english, { wordCount: 9 }));
  assert.throws(() => analytics.plan([], dictionary.english, { wordCount: 10.5 }));
  assert.throws(() => analytics.plan([], dictionary.english, { manualTargets: ['ст'] }));
  assert.throws(() => analytics.plan([], dictionary.english, { ratio: 2 }));
});

test('sequences accept 3–5 letters and generate focused exercises', () => {
  assert.deepEqual(plain(options.parseTargets('стр, ость', 'russian', 'sequences')), ['стр', 'ость']);
  for (const value of ['ст', 'скорость']) {
    assert.throws(() => options.parseTargets(value, 'russian', 'sequences'));
  }
  const p = analytics.plan([], dictionary.russian, {
    language: 'russian', kind: 'sequences', manualTargets: ['стр', 'ость'], ratio: 1, wordCount: 20
  });
  assert.equal(p.kind, 'sequences');
  assert.ok(analytics.validPlan(p));
  assert.ok(p.words.every(word => word.includes('стр') || word.includes('ость')));
  assert.deepEqual(plain(p.targets), ['стр', 'ость']);
});

test('sequence statistics count overlapping windows and preserve corrected errors', () => {
  const events = [...'street'].map((typed, position) => ({
    target: 'street', typed, position, wordIndex: 0, type: 'insert', time: position * 100
  }));
  const clean = context.KeyloomCore.analyze(events, { mode: 'words' });
  assert.equal(Object.keys(clean.sequences).length, 9);
  assert.deepEqual(plain(clean.sequences.str.timings), [100]);
  assert.deepEqual(plain(clean.sequences.stree.timings), [100]);
  const dirty = events.map(event => ({ ...event }));
  dirty[1].typed = 'x';
  dirty.splice(2, 0,
    { ...events[1], type: 'delete', time: 120 },
    { ...events[1], time: 140 }
  );
  const result = context.KeyloomCore.analyze(dirty, { mode: 'words' });
  assert.equal(result.sequences.str.errors, 1);
  assert.equal(result.sequences.str.timings.length, 0);
  assert.equal(result.sequences.eet.errors, 0);
  assert.equal(result.sequences.eet.timings[0], 100);
  assert.ok(context.KeyloomCore.validateSession(result));
});

test('old sessions remain valid and do not invent sequence observations', () => {
  const old = context.KeyloomCore.analyze([], { mode: 'words' });
  delete old.sequences;
  assert.ok(context.KeyloomCore.validateSession(old));
  assert.equal(context.KeyloomCore.profile([old]).sequences.length, 0);
});

test('sequence timing excludes pauses and incomplete windows', () => {
  const events = [...'street'].map((typed, position) => ({
    target: 'street', typed, position, wordIndex: 0, type: 'insert', time: position * 100 + (position >= 2 ? 3000 : 0)
  }));
  const session = context.KeyloomCore.analyze(events.slice(0, 4));
  assert.equal(session.sequences.str.timings.length, 0);
  assert.equal(session.sequences.stree, undefined);
  assert.equal(session.sequences.eet, undefined);
});

test('extras are opt-in and all decorated tokens are supported', () => {
  const base = analytics.plan([], dictionary.english, { kind: 'mixed', wordCount: 20 });
  assert.ok(base.words.every(word => /^[a-z]+$/u.test(word)));
  const decorated = analytics.plan([], dictionary.russian, {
    language: 'russian', kind: 'mixed', wordCount: 20,
    extras: { uppercase: true, digits: true, punctuation: true }
  });
  assert.ok(decorated.words.some(word => /[А-ЯЁ]/u.test(word)));
  assert.ok(decorated.words.some(word => /[0-9]/u.test(word)));
  assert.ok(decorated.words.some(word => /[.,!?]/u.test(word)));
  assert.ok(analytics.validPlan(decorated));
});

test('specialized modes support manual goals and language-specific capitals', () => {
  for (const [kind, goals] of [['uppercase', ['П', 'С']], ['digits', ['0', '7']], ['punctuation', [',', '!']]]) {
    const plan = analytics.plan([], dictionary.russian, {
      language: 'russian', kind, manualTargets: goals, wordCount: 20
    });
    assert.ok(analytics.validPlan(plan), kind);
    assert.deepEqual(plain(plan.targets), goals);
    assert.ok(plan.words.every(word => goals.some(goal => word.includes(goal))), kind);
  }
  assert.deepEqual(plain(options.parseTargets('п с', 'russian', 'uppercase')), ['П', 'С']);
  assert.deepEqual(plain(options.parseTargets(', !', 'english', 'punctuation')), [',', '!']);
  assert.throws(() => options.parseTargets('A', 'russian', 'uppercase'));
  assert.throws(() => analytics.plan([], dictionary.russian, { language: 'russian', kind: 'uppercase', manualTargets: ['A'] }));
});

test('digits and punctuation profiles are shared across languages, capitals are separate', () => {
  const core = context.KeyloomCore;
  function record(word, language, layout = 'default') {
    return core.analyze([...word].map((typed, position) => ({
      target: word, typed, position, wordIndex: 0, type: 'insert', time: position * 100
    })), { language, layout, mode: 'quote' });
  }
  const ru = record('А7!', 'russian');
  const en = record('A7!', 'english');
  const alternate = record('A7!', 'english', 'alternate');
  const sessions = [ru, en, alternate];
  const profile = core.profile(sessions, { language: 'russian' });
  assert.equal(profile.digits.find(row => row.key === '7').attempts, 2);
  assert.deepEqual(plain(profile.digits), plain(core.profile(sessions, { language: 'english' }).digits));
  assert.deepEqual(plain(profile.punctuation), plain(core.profile(sessions, { language: 'english' }).punctuation));
  assert.equal(profile.punctuation.find(row => row.key === '!').attempts, 2);
  assert.deepEqual(plain(profile.uppercase.map(row => row.key)), ['А']);
  assert.ok(core.validateSession(ru));
  const legacy = { ...en };
  delete legacy.uppercase; delete legacy.digits; delete legacy.punctuation;
  assert.ok(core.validateSession(legacy));
  assert.equal(core.profile([legacy]).uppercase.length, 0);
});

test('wrong case and symbol corrections remain errors in first-attempt statistics', () => {
  const events = [
    { target: 'A7!', position: 0, typed: 'a', time: 0, type: 'insert', wordIndex: 0 },
    { target: 'A7!', position: 0, time: 20, type: 'delete', wordIndex: 0 },
    { target: 'A7!', position: 0, typed: 'A', time: 40, type: 'insert', wordIndex: 0 },
    { target: 'A7!', position: 1, typed: '8', time: 140, type: 'insert', wordIndex: 0 },
    { target: 'A7!', position: 2, typed: ' ', time: 240, type: 'insert', wordIndex: 0 }
  ];
  const result = context.KeyloomCore.analyze(events);
  assert.equal(result.uppercase.A.errors, 1);
  assert.equal(result.digits['7'].errors, 1);
  assert.equal(result.punctuation['!'].errors, 1);
  assert.equal(result.uppercase.A.attempts, 1);
});
