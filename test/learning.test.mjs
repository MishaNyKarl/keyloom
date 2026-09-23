import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
const context = vm.createContext({crypto:webcrypto, URL, TextEncoder, structuredClone});
for (const name of ['core','analytics','learning','daily','words','vendor/lz-string','practice']) {
  vm.runInContext(await readFile(new URL('../extension/' + name + '.js', import.meta.url), 'utf8'), context);
}
const {KeyloomLearning:l, KeyloomDaily:d, KeyloomCore:c} = context;
const now = Date.UTC(2026, 8, 1, 12);
const DAY = 86400000;
const metric = (errors = 0) => ({attempts:10, errors, timings:[100,110,120]});
const session = (id, extra = {}) => ({id,date:now,language:'english',layout:'default',mode:'time',status:'completed',
  source:'synthetic',duration:60,presses:100,corrections:0,wpm:60,accuracy:98,
  chars:{},pairs:{th:metric()},sequences:{},words:{thimble:metric()},...extra});
const trained = (id, extra = {}) => session(id, {mode:'custom',
  training:{id:'exercise-' + id,kind:'pairs',targets:['th'],seconds:60},...extra});

test('durable vocabulary survives eviction and replay without mixing languages or layouts', () => {
  const initial = l.ingest(null, [session('one'), session('abandoned',{status:'abandoned',words:{ignored:metric()}})]);
  const next = l.ingest(initial, [session('two',{words:{newword:metric()}})]);
  assert.deepEqual(Array.from(l.vocabulary(next,'english','default')), ['thimble','newword']);
  assert.equal(l.vocabulary(next,'russian','default').length, 0);
  assert.equal(l.vocabulary(next,'english','alternate').length, 0);
  assert.equal(JSON.stringify(l.ingest(next, [session('one')])), JSON.stringify(next));
  assert.equal(l.validate(next), true);
  assert.equal(l.validate({...next,vocabulary:{'english:default':['<script>']}}), false);
  assert.equal(l.validate({...next,vocabulary:{'english:default':Array(5001).fill('word')}}), false);
});

test('repeat schedule advances once, uses elapsed days, and resets after errors', () => {
  let value = l.ingest(null, [trained('first')]);
  let review = Object.values(value.reviews)[0];
  assert.equal(review.due, now + 3 * DAY);
  assert.equal(l.due(value,'english','default',now).length, 0);
  assert.equal(l.due(value,'english','default',now + 3 * DAY).length, 1);
  const sameDay = l.ingest(value, [trained('same-day',{date:now + 1000})]);
  assert.equal(Object.values(sameDay.reviews)[0].level, 1);
  assert.equal(Object.values(sameDay.reviews)[0].due, now + 3 * DAY);
  value = l.ingest(value, [trained('second',{date:now + 4 * DAY})]);
  review = Object.values(value.reviews)[0];
  assert.equal(review.level,2);
  assert.equal(review.due,now + 11 * DAY);
  const replay = l.ingest(value,[trained('first')]);
  assert.equal(JSON.stringify(replay),JSON.stringify(value));
  value = l.ingest(value,[trained('failure',{date:now + 12 * DAY,pairs:{th:metric(2)}})]);
  assert.equal(Object.values(value.reviews)[0].level,0);
  assert.equal(Object.values(value.reviews)[0].due,now + 13 * DAY);
});

test('transfer compares only ordinary tests in matching scope before and after training', () => {
  const rows = [session('before',{date:now-DAY,pairs:{th:metric(3)}}), trained('practice'),
    session('after',{date:now+DAY,pairs:{th:metric(1)}}),
    session('foreign',{date:now+DAY,language:'russian',pairs:{th:metric(9)}})];
  const result = l.transfer(rows,'english','default')[0];
  assert.equal(result.ready,true);
  assert.equal(result.before.error,.3);
  assert.equal(result.after.error,.1);
  assert.equal(result.after.attempts,10);
  assert.equal(l.transfer(rows.slice(0,2),'english','default')[0].ready,false);
});

test('forecast requires comparable multi-day data, positive trend and similar workload', () => {
  const rows = Array.from({length:28},(_,index)=>session('trend-' + index,
    {date:now-(13-Math.floor(index/2))*DAY+index,wpm:40+Math.floor(index/2)}));
  const estimate = l.forecast(rows,'english','default',2,now+100);
  assert.equal(estimate.reason,'ready');
  assert.ok(estimate.milestones.every(row=>row.latest>=row.earliest && row.earliest>0));
  assert.equal(l.forecast(rows.slice(0,6),'english','default',2,now).reason,'data');
  assert.equal(l.forecast(rows,'english','default',20,now+100).reason,'load');
  assert.equal(l.forecast(rows.map(row=>({...row,wpm:50})),'english','default',2,now+100).reason,'trend');
  assert.equal(l.forecast(rows.map(row=>({...row,mode:'quote'})),'english','default',2,now+100).reason,'data');
});

test('daily plans fit time budget, include both languages, and native URLs use correct settings', () => {
  for (const minutes of [5,10,20,45]) {
    const plan = d.create({minutes},[], 'default',now,'day-plan');
    assert.equal(plan.steps.reduce((sum,row)=>sum+row.seconds,0), minutes*60);
    assert.ok(plan.steps.some(row=>row.language==='english'));
    assert.ok(plan.steps.some(row=>row.language==='russian'));
    assert.ok(plan.steps.every(row=>row.seconds>=30));
    assert.equal(new Set(plan.steps.map(row=>row.id)).size,plan.steps.length);
  }
  const plan = d.create({},[], 'default',now,'day-plan');
  const quote = plan.steps.find(row=>row.type==='quote');
  const url = new URL(d.nativeUrl(plan,quote));
  const settings = JSON.parse(context.LZString.decompressFromEncodedURIComponent(url.searchParams.get('testSettings')));
  assert.equal(settings[0],'quote');
  assert.equal(settings[1],String(quote.quoteId));
  assert.equal(settings[5],quote.language);
  assert.throws(()=>d.options({minutes:-1}));
  assert.throws(()=>d.options({targets:'th',kind:'auto'}));
});

test('both repair uses errors and slow words from the preceding test', () => {
  const source = session('result',{words:{errorword:metric(2),slowword:{attempts:5,errors:0,timings:[500,500,500]},fastword:{attempts:5,errors:0,timings:[50,50,50]}}});
  const plan = d.create({repeat:false,languages:'english'},[source],'default',now,'plan');
  plan.steps[0].result = {id:source.id};
  const step = plan.steps.find(row=>row.type==='repair');
  const exercise = d.exercise(plan,step,[source],l.ingest(null,[source]),['fastword'],()=>.3);
  assert.equal(exercise.kind,'words');
  assert.ok(exercise.targets.includes('errorword'));
  assert.ok(exercise.targets.includes('slowword'));
  assert.equal(exercise.targets.includes('fastword'),false);
  for (const word of ['errorword', 'slowword']) {
    assert.ok(exercise.words.filter(value => value === word).length >= 2);
  }
  const triple = d.exercise(plan,step,[source],l.ingest(null,[source]),['fastword'],()=>.9);
  for (const word of ['errorword', 'slowword']) {
    assert.ok(triple.words.filter(value => value === word).length >= 3);
  }
  assert.equal(exercise.seconds,60);
  assert.ok(exercise.words.join(' ').length >= 300);
  assert.equal(context.KeyloomAnalytics.validPlan(triple),true);
  assert.equal(context.KeyloomAnalytics.validPlan(exercise),true);
});

test('step completion requires matching launch and completed test and is idempotent', () => {
  const plan = d.create({repeat:false,repair:false,quote:false,languages:'english'},[],'default',now,'daily');
  // Retain coverage for saved plans created before warmup steps existed.
  plan.steps = plan.steps.filter(step => !['warmup','cooldown'].includes(step.type));
  const step = plan.steps[0];
  step.startedAt = now;
  const url = 'https://monkeytype.com/?keyloomDaily=daily&keyloomStep=' + step.id;
  const result = session('done');
  for (const changes of [{status:'abandoned'},{language:'russian'},{layout:'alternate'},{duration:2},{date:now-1}]) {
    assert.equal(d.complete([plan],{...result,...changes},url)[0].steps[0].result,undefined);
  }
  const done = d.complete([plan],result,url);
  assert.equal(done[0].steps[0].result.id,result.id);
  assert.equal(d.complete(done,result,url)[0].steps.filter(row=>row.result).length,1);
  assert.equal(plan.steps[0].result,undefined);
});

test('persisted words remain usable for explicit practice after source sessions disappear', () => {
  const learning = l.ingest(null,[session('word')]);
  const plan = d.create({kind:'pairs',targets:'th',repeat:false},[],'default',now,'target');
  const step = plan.steps.find(row=>row.type==='focus');
  const exercise = d.exercise(plan,step,[],learning,['cat'],()=>.1);
  assert.ok(exercise.words.includes('thimble'));
  assert.ok(c.validateSession(session('word')));
});

test('minute norm counts results once and continues across days, scoped by language and layout', () => {
  const rows = [session('today',{duration:300}),session('yesterday',{date:now-DAY,duration:300}),
    session('foreign',{language:'russian',duration:500}),session('other-layout',{layout:'alternate',duration:500})];
  const dailies = [{layout:'default',steps:[{language:'english',result:rows[0]}]}];
  const progress = d.progress(rows,dailies,{languages:'english',minutes:5},'default',now);
  assert.equal(progress.minutes,5);
  assert.equal(progress.streak,2);
  assert.equal(d.progress([],dailies,{languages:'english',minutes:5},'default',now).minutes,5);
  assert.equal(d.progress(rows,dailies,{languages:'english',minutes:10},'default',now).streak,0);
});

test('manual daily targets reject mixed scripts and wrong languages', () => {
  assert.throws(()=>d.options({kind:'pairs',targets:'aя'}));
  assert.throws(()=>d.options({kind:'pairs',targets:'ст',languages:'english'}));
  assert.equal(d.options({kind:'pairs',targets:'TH ст',languages:'both'}).targets,'th ст');
});

test('a completed configured minute test counts even when the last keystroke was early', () => {
  const plan = d.create({repeat:false,repair:false,quote:false,languages:'english'},[],'default',now,'paused');
  plan.steps = plan.steps.filter(step => !['warmup','cooldown'].includes(step.type));
  plan.steps[0].startedAt = now;
  const url = 'https://monkeytype.com/?keyloomDaily=paused&keyloomStep=' + plan.steps[0].id;
  assert.ok(d.complete([plan],session('paused-result',{duration:40}),url,60)[0].steps[0].result);
  assert.equal(d.complete([plan],session('wrong-duration'),url,30)[0].steps[0].result,undefined);
});

test('every goal retains a minute baseline so daily practice can calibrate the forecast', () => {
  for (const goal of ['balanced','speed','accuracy','text']) {
    const plan = d.create({goal,minutes:5,kind:'words'},[],'default',now,'baseline');
    for (const language of ['english','russian']) {
      assert.ok(plan.steps.some(step=>step.language===language && step.type==='time' && step.seconds===60));
    }
  }
});

test('transfer of digits is shared between languages like the review schedule', () => {
  const rows = [session('before-digit',{date:now-DAY,digits:{'1':metric(2)}}),
    trained('digit',{digits:{'1':metric()},training:{id:'digits',kind:'digits',targets:['1'],seconds:60}}),
    session('after-digit',{date:now+DAY,language:'russian',digits:{'1':metric(1)}})];
  const result = l.transfer(rows,'russian','default')[0];
  assert.equal(result.target,'1');
  assert.equal(result.ready,true);
  assert.equal(result.before.error,.2);
  assert.equal(result.after.error,.1);
});

test('every daily plan brackets each language with identical fixed warmup text', () => {
  for (const minutes of [5,10,15,20,25,30,35,45,60]) {
    for (const languages of ['english','russian','both']) {
      for (const goal of ['balanced','speed','accuracy','text']) {
        const plan = d.create({minutes,languages,goal},[],'default',now,'warmup');
        assert.equal(plan.steps.reduce((sum,step) => sum + step.seconds,0),minutes * 60);
        for (const language of languages === 'both' ? ['english','russian'] : [languages]) {
          const steps = plan.steps.filter(step => step.language === language);
          assert.equal(steps[0].type,'warmup');
          assert.equal(steps.at(-1).type,'cooldown');
          assert.equal(steps[0].seconds,30);
          assert.deepEqual(steps[0].words,steps.at(-1).words);
          const start = d.exercise(plan,steps[0],[],null,[],()=>.1);
          const end = d.exercise(plan,steps.at(-1),[session('faster',{wpm:150})],null,[],()=>.9);
          assert.ok(context.KeyloomAnalytics.validPlan(start));
          assert.ok(context.KeyloomAnalytics.validPlan(end));
          assert.deepEqual(start.words,end.words);
          assert.notEqual(start.id,end.id);
          assert.equal(start.wordCount,start.words.length);
        }
      }
    }
  }
});
test('warmup size follows language speed and comparison preserves slower results and accuracy', () => {
  const plan = d.create({},[session('fast',{wpm:100})],'default',now,'compare');
  const english = plan.steps.filter(step => step.language === 'english');
  const russian = plan.steps.filter(step => step.language === 'russian');
  assert.ok(english[0].words.join(' ').length > russian[0].words.join(' ').length);
  assert.equal(d.comparisons(plan).length,0);
  english[0].result = {duration:30,accuracy:99};
  assert.equal(d.comparisons(plan).length,0);
  english.at(-1).result = {duration:35,accuracy:97};
  const result = d.comparisons(plan)[0];
  assert.equal(result.before,30);
  assert.equal(result.after,35);
  assert.equal(result.saved,-5);
  assert.equal(result.afterAccuracy,97);
  english.at(-1).words = ['different'];
  assert.equal(d.comparisons(plan).length,0);
  assert.equal(d.comparisons({steps:[]}).length,0);
});
test('warmup completion requires its own exercise and rejects interrupted runs', () => {
  const plan = d.create({languages:'english'},[],'default',now,'warmup');
  const step = plan.steps[0];
  step.startedAt = now;
  step.exerciseId = 'warmup-exercise';
  const url = 'https://monkeytype.com/?keyloomDaily=warmup&keyloomStep=' + step.id;
  const result = session('warmup-result',{mode:'custom',duration:28,
    training:{id:step.exerciseId,kind:'words',targets:[],seconds:30}});
  for (const change of [{status:'abandoned'},{training:undefined},{training:{id:'wrong'}},{language:'russian'}]) {
    assert.equal(d.complete([plan],{...result,...change},url)[0].steps[0].result,undefined);
  }
  const completed = d.complete([plan],result,url);
  assert.equal(completed[0].steps[0].result.duration,28);
  assert.equal(d.complete(completed,result,url)[0].steps.filter(step => step.result).length,1);
});

test('forecast chooses independent +5 and +10 milestones for each language', () => {
  const rows = ['english','russian'].flatMap((language, languageIndex) =>
    Array.from({length:28}, (_, index) => session(language + index, {
      language, date:now-(13-Math.floor(index/2))*DAY+index,
      wpm:40 + languageIndex * 30 + Math.floor(index/2)
    })));
  const en = l.forecast(rows,'english','default',2,now+100);
  const ru = l.forecast(rows,'russian','default',2,now+100);
  for (const estimate of [en, ru]) {
    assert.equal(estimate.reason, 'ready');
    assert.deepEqual(Array.from(estimate.goals), [estimate.current+5, estimate.current+10]);
    assert.deepEqual(Array.from(estimate.milestones, row => row.wpm), Array.from(estimate.goals));
  }
  assert.equal(ru.current-en.current, 30);
  assert.equal(l.forecast([],'english','default',10,now).goals.length, 0);
});

test('legacy daily speed target is ignored without affecting plan options', () => {
  const prefs = d.options({target:80, minutes:25, languages:'both'});
  assert.equal(prefs.target, undefined);
  assert.equal(prefs.minutes, 25);
  assert.equal(prefs.languages, 'both');
});

test('daily results separate languages, preserve partial plans and summarize saved steps', () => {
  assert.deepEqual(Array.from(d.results(null)), []);
  const plan = {steps:[
    {language:'english',type:'warmup',words:['same'],result:{duration:30,wpm:40,accuracy:98}},
    {language:'english',type:'time',result:{duration:60,wpm:80,accuracy:99}},
    {language:'english',type:'cooldown',words:['same'],result:{duration:25,wpm:48,accuracy:97}},
    {language:'russian',type:'warmup',words:['текст'],result:{duration:35,wpm:30,accuracy:96}},
    {language:'russian',type:'cooldown',words:['текст']}
  ]};
  const [en, ru] = d.results(plan);
  assert.equal(en.done, 3);
  assert.equal(en.seconds, 115);
  assert.equal(en.medianWpm, 48);
  assert.equal(en.bestWpm, 80);
  assert.equal(en.beforeWpm, 40);
  assert.equal(en.afterWpm, 48);
  assert.equal(en.comparison.saved, 5);
  assert.equal(ru.done, 1);
  assert.equal(ru.total, 2);
  assert.equal(ru.seconds, 35);
  assert.equal(ru.comparison, null);
  const empty = d.results({steps:[{language:'english',type:'time'}]})[0];
  assert.equal(empty.medianWpm, null);
  assert.equal(empty.bestWpm, null);
  assert.equal(empty.seconds, 0);
});

test('daily plans round trip with streak, preferences and deduplicated results', () => {
  const plan = d.create({minutes:5,languages:'english'}, [], 'default', now, 'backup');
  for (const step of plan.steps) step.result = {id:step.id,date:now,duration:step.seconds,wpm:60,accuracy:99};
  const restored = d.importPlans([], JSON.parse(JSON.stringify([plan])));
  assert.equal(d.progress([], restored, restored[0].prefs, 'default', now).streak, 1);
  assert.equal(d.comparisons(restored[0]).length, 1);
  assert.equal(d.importPlans(restored, [plan]).length, 1);
  assert.equal(d.importPlans(restored, undefined), restored);
  assert.throws(() => d.importPlans([], [{...plan,steps:[{...plan.steps[0],result:{wpm:-1}}]}]));
  const partial = structuredClone(plan);
  delete partial.steps[1].result;
  assert.equal(d.importPlans([partial], [plan])[0].steps[1].result.id, plan.steps[1].id);
});


test('legacy thirty-second both steps still produce one minute of targeted text', () => {
  const source = session('legacy-source', {wpm:90, words:{cat:metric(1)}});
  const plan = d.create({languages:'english'}, [source], 'default', now, 'legacy-both');
  plan.steps[0].result = {id:source.id};
  const step = plan.steps.find(row => row.type === 'repair');
  step.seconds = 30;
  const exercise = d.exercise(plan, step, [source], l.ingest(null, [source]), ['cat'], () => .2);
  assert.equal(exercise.seconds, 60);
  assert.ok(exercise.words.join(' ').length >= 450);
  assert.ok(exercise.words.every(word => word === 'cat'));
  assert.equal(context.KeyloomAnalytics.validPlan(exercise), true);
});

test('backup restores multiple dates and streak without sessions, but a missed day breaks it', () => {
  const plans = Array.from({length:7}, (_, index) => {
    const date = now - index * DAY;
    const plan = d.create({minutes:5,languages:'both'}, [], 'default', date, 'backup-' + index);
    for (const step of plan.steps) {
      step.result = {id:step.id, date, duration:step.seconds, wpm:60, accuracy:98};
    }
    return plan;
  });
  const restored = d.importPlans([], JSON.parse(JSON.stringify(plans)));
  assert.equal(restored.length, 7);
  assert.equal(d.progress([], restored, restored[0].prefs, 'default', now).streak, 7);
  assert.equal(d.progress([], restored, restored[0].prefs, 'default', now + 2 * DAY).streak, 0);
});

test('focus kind survives backup and controls the generated exercise', () => {
  const plan = d.create({languages:'english',kind:'words'}, [], 'default', now, 'focus-kind');
  const step = plan.steps.find(row => row.type === 'focus');
  step.kind = 'pairs';
  const restored = d.importPlans([], JSON.parse(JSON.stringify([plan])))[0];
  const restoredStep = restored.steps.find(row => row.id === step.id);
  assert.equal(restoredStep.kind, 'pairs');
  const exercise = d.exercise(restored, restoredStep, [session('focus-source')], null, ['thimble'], () => .2);
  assert.equal(exercise.kind, 'pairs');
  assert.equal(context.KeyloomAnalytics.validPlan(exercise), true);
});
