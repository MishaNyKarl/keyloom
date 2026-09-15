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
  const estimate = l.forecast(rows,'english','default',2,70,now+100);
  assert.equal(estimate.reason,'ready');
  assert.ok(estimate.milestones.every(row=>row.latest>=row.earliest && row.earliest>0));
  assert.equal(l.forecast(rows.slice(0,6),'english','default',2,70,now).reason,'data');
  assert.equal(l.forecast(rows,'english','default',20,70,now+100).reason,'load');
  assert.equal(l.forecast(rows.map(row=>({...row,wpm:50})),'english','default',2,70,now+100).reason,'trend');
  assert.equal(l.forecast(rows.map(row=>({...row,mode:'quote'})),'english','default',2,70,now+100).reason,'data');
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
  assert.equal(context.KeyloomAnalytics.validPlan(exercise),true);
});

test('step completion requires matching launch and completed test and is idempotent', () => {
  const plan = d.create({repeat:false,repair:false,quote:false,languages:'english'},[],'default',now,'daily');
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
