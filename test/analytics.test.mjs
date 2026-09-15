import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
const context=vm.createContext({crypto:webcrypto,TextEncoder});
for(const name of ['core','analytics','words'])vm.runInContext(await readFile(new URL(`../extension/${name}.js`,import.meta.url),'utf8'),context);
const {KeyloomAnalytics:a,KeyloomCore:c,KeyloomWords:dict}=context;
const now=new Date(2026,8,14,12).getTime();
const s=(offset=0,extra={})=>({date:now-offset*86400000,language:'english',layout:'default',status:'completed',mode:'words',duration:60,wpm:40,accuracy:90,presses:100,corrections:2,pairs:{},chars:{},words:{},...extra});
test('streak uses local days, accepts yesterday, excludes abandoned and other languages',()=>{
 const rows=[s(1),s(1),s(2),s(4),s(0,{status:'abandoned'}),s(0,{language:'russian'})];
 const r=a.summary(rows,{now});assert.equal(r.streak,2);assert.equal(r.best,2);assert.equal(r.activeDays,3);
 assert.equal(a.summary([s(2)],{now}).streak,0);
 assert.equal(a.summary([s(),s(1),s(2)],{now}).streak,3);
 assert.equal(a.day(new Date(2026,8,14,0).getTime()),a.day(new Date(2026,8,14,23,59).getTime()));
});
test('growth needs two groups of five eligible results in chronological order',()=>{
 const rows=Array.from({length:10},(_,i)=>s(9-i,{wpm:i<5?40:50}));
 const r=a.summary(rows.reverse(),{now});assert.equal(r.growth.wpm,10);assert.equal(r.growth.percent,25);
 assert.equal(a.summary(rows.slice(1),{now}).growth,null);
 assert.equal(a.summary(rows.map((x,i)=>i===0?{...x,duration:1}:x),{now}).growth,null);
});
test('statistics filters language, layout, period and mode; accuracy is weighted',()=>{
 const rows=[s(0,{accuracy:80}),s(1,{accuracy:100,presses:300}),s(9),s(0,{mode:'custom'}),s(0,{language:'russian'}),s(0,{layout:'alternate'})];
 const r=a.summary(rows,{now,days:7,mode:'words'});assert.equal(r.completed.length,2);assert.equal(r.accuracy,95);assert.equal(r.minutes,2);
});
test('practiced pairs require observed targets in completed linked exercises',()=>{
 const training={targets:['st','th']};const pairs={st:{attempts:3}};
 assert.equal(a.summary([s(0,{training,pairs}),s(1,{training,pairs}),s(2,{training:{targets:['th']},pairs:{th:{attempts:1}},status:'abandoned'})],{now}).practiced,1);
});
test('duration uses last 20 chronological tests and scales by actual characters',()=>{
 const rows=Array.from({length:21},(_,i)=>s(i,{wpm:i===20?999:60}));
 const p=a.plan(rows,dict.english,{seconds:60,kind:'mixed',random:()=>.3});
 assert.equal(p.wpm,60);assert.ok(Math.abs(p.words.join(' ').length-300)<12);assert.equal(p.calibrating,false);assert.ok(a.validPlan(p));
 const longer=a.plan(rows,dict.english,{seconds:120,kind:'mixed',random:()=>.3});assert.ok(longer.words.length>p.words.length*1.8);
});
test('calibration and Russian plans remain valid; malformed plans are rejected',()=>{
 const p=a.plan([],dict.russian,{language:'russian',seconds:30});assert.equal(p.calibrating,true);assert.equal(p.wpm,40);assert.ok(a.validPlan(p));
 assert.equal(a.validPlan({...p,words:['bad value']}),false);assert.equal(a.validPlan({...p,seconds:17}),false);
});

test('chart scale follows actual extrema instead of forcing a zero baseline', () => {
  const scale = a.chartScale([71, 72, 74]);
  assert.ok(scale.min > 60 && scale.min <= 71);
  assert.ok(scale.max >= 74 && scale.max < 90);
  assert.ok(scale.ticks.length >= 3);
  assert.equal(new Set(scale.ticks).size, scale.ticks.length);
});

test('chart scale handles flat, empty, zero and accuracy boundary data', () => {
  for (const values of [[], [0], [80, 80], [NaN, Infinity]]) {
    const scale = a.chartScale(values);
    assert.ok(Number.isFinite(scale.min) && scale.max > scale.min);
  }
  for (const values of [[99.2, 99.8], [100], [0], [0, 100]]) {
    const scale = a.chartScale(values, 'accuracy');
    assert.ok(scale.min >= 0 && scale.max <= 100 && scale.max > scale.min);
    for (const value of values) assert.ok(value >= scale.min && value <= scale.max);
  }
});
