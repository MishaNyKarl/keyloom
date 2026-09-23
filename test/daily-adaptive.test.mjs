import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
const context = vm.createContext({crypto:webcrypto, URL, TextEncoder, structuredClone});
for (const name of ['core', 'analytics', 'learning', 'daily', 'words', 'vendor/lz-string']) {
  vm.runInContext(await readFile(new URL('../extension/' + name + '.js', import.meta.url), 'utf8'), context);
}
const {KeyloomDaily:d, KeyloomAnalytics:a} = context;
const now = new Date(2026, 8, 23, 12).getTime();
const session = (language, wpm) => ({id:language, date:now, language, layout:'default',
  status:'completed', mode:'time', duration:60, wpm, accuracy:98, presses:300,
  chars:{}, pairs:{}, words:{}, sequences:{}});

test('adaptive plans cover the core loads within every supported time and language budget', () => {
  for (const minutes of [5,10,15,20,25,30,35,45,60]) {
    for (const languages of ['english', 'russian', 'both']) {
      const plan = d.create({goal:'adaptive', minutes, languages}, [], 'default', now, 'plan');
      assert.equal(plan.steps.reduce((sum, step) => sum + step.seconds, 0), minutes * 60);
      assert.ok(plan.steps.length <= 240);
      assert.equal(d.importPlans([], [plan]).length, 1);
      for (const language of languages === 'both' ? ['english','russian'] : [languages]) {
        const steps = plan.steps.filter(step => step.language === language);
        assert.equal(steps[0].type, 'warmup');
        assert.equal(steps.at(-1).type, 'cooldown');
        assert.deepEqual(steps[0].words, steps.at(-1).words);
        assert.ok(steps.some(step => step.type === 'time' && step.seconds === 15));
        assert.ok(steps.some(step => step.label.startsWith('Чистый ритм')));
        assert.ok(steps.some(step => step.type === 'focus'));
        if (minutes / (languages === 'both' ? 2 : 1) >= 5) {
          for (const kind of ['pairs','sequences','words']) {
            assert.ok(steps.some(step => step.type === 'focus' && step.kind === kind));
          }
          assert.ok(steps.some(step => step.label.startsWith('Выносливость')));
        }
        for (const step of steps.filter(step => ['warmup','cooldown','focus','review','repair'].includes(step.type))) {
          const exercise = d.exercise(plan, step, [], null, context.KeyloomWords[language], () => .4);
          assert.ok(a.validPlan(exercise), JSON.stringify(step));
        }
      }
    }
  }
});

test('adaptive speed guidance is based on each language, not a fixed target', () => {
  const plan = d.create({goal:'adaptive'}, [session('english', 80), session('russian', 100)], 'default', now, 'plan');
  assert.match(plan.steps.find(step => step.language === 'english' && step.seconds === 15).label, /88 WPM/);
  assert.match(plan.steps.find(step => step.language === 'russian' && step.seconds === 15).label, /110 WPM/);
});

test('rolling plans keep today intact, rebuild only untouched tomorrow and roll over once', () => {
  let count = 0;
  const id = () => 'plan-' + count++;
  const prefs = {goal:'adaptive', minutes:10};
  const initial = d.schedule([], prefs, [], 'default', now, false, id);
  assert.equal(initial.length, 2);
  assert.equal(initial[1].day, initial[0].day + 1);
  assert.equal(d.schedule(initial, prefs, [], 'default', now, false, id), initial);
  initial[0].steps[0].startedAt = now;
  const refreshed = d.schedule(initial, prefs, [session('english', 90)], 'default', now, true, id);
  assert.equal(refreshed[0], initial[0]);
  assert.notEqual(refreshed[1].id, initial[1].id);
  refreshed[1].steps[0].startedAt = now;
  assert.equal(d.schedule(refreshed, prefs, [], 'default', now, true, id), refreshed);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const rolled = d.schedule(refreshed, prefs, [], 'default', tomorrow.getTime(), false, id);
  assert.equal(rolled.length, 3);
  assert.equal(rolled[1], refreshed[1]);
  assert.equal(rolled[2].day, rolled[1].day + 1);
  assert.equal(d.schedule([], undefined, [], 'default', now).length, 0);
});

test('one extreme key does not flatten a varied accuracy map', () => {
  const scale = a.keyboardScale([0,.005,.01,.015,.02,.025,.03,.035,.04,.045,.05,1]
    .map(errorRate => ({attempts:20, errorRate})));
  assert.equal(scale.actualMax, 1);
  assert.ok(scale.clipped);
  assert.ok(scale.max < .15);
  assert.equal(scale.levels.at(-1), 3);
  assert.ok(new Set(scale.levels.slice(0, -1)).size >= 3);
  const unchanged = a.keyboardScale([0,.01,.02,.03,.04,.05,.06,.07].map(errorRate => ({attempts:20,errorRate})));
  assert.equal(unchanged.clipped, false);
  assert.equal(unchanged.max, .07);
});

test('adaptive custom targets apply only to matching blocks and special categories are included', () => {
  for (const [kind, target] of [['pairs','th'], ['words','school'], ['digits','7'],
    ['uppercase','A'], ['punctuation','.']]) {
    const plan = d.create({goal:'adaptive', minutes:10, kind, targets:target, repeat:false,
      languages:'english'}, [], 'default', now, 'manual');
    const restored = d.importPlans([], [plan])[0];
    const matching = restored.steps.find(step => step.type === 'focus' && step.kind === kind);
    assert.ok(matching, kind);
    const exercise = d.exercise(restored, matching, [], null, context.KeyloomWords.english, () => .4);
    assert.ok(exercise.targets.includes(target));
    assert.ok(a.validPlan(exercise));
    for (const step of restored.steps.filter(step => step.type === 'focus' && step.kind !== kind)) {
      assert.ok(a.validPlan(d.exercise(restored, step, [], null, context.KeyloomWords.english, () => .4)));
    }
  }
});
