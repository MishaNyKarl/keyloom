import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import '../extension/core.js';
import '../extension/words.js';
import '../extension/demo.js';
const core = globalThis.KeyloomCore;
const e = (target, position, typed, time, type = 'insert', wordIndex = 0) => ({ target, position, typed, time, type, wordIndex });
const simple = () => core.analyze([e('test',0,'t',0),e('test',1,'e',100),e('test',2,'s',220),e('test',3,'t',340),e('test',4,' ',440)]);

test('corrected errors remain in first-pass character, pair and word accuracy', () => {
  const s = core.analyze([e('cat',0,'c',0),e('cat',1,'x',100),e('cat',2,'',200,'delete'),e('cat',1,'a',300),e('cat',2,'t',400),e('cat',3,' ',500)]);
  assert.equal(s.chars.a.errors,1); assert.equal(s.chars.a.attempts,1);
  assert.equal(s.pairs.ca.errors,1); assert.equal(s.words.cat.errors,1);
  assert.equal(s.corrections,1); assert.equal(s.presses,5); assert.equal(s.accuracy,80);
  assert.deepEqual(s.pairs.at.timings,[]); assert.deepEqual(s.words.cat.timings,[]);
});
test('clean transitions use actual inter-letter intervals', () => {
  const s = simple(); assert.deepEqual(s.pairs.te.timings,[100]); assert.deepEqual(s.pairs.es.timings,[120]);
  assert.equal(s.accuracy,100); assert.equal(s.words.test.errors,0);
  assert.equal(Math.round(s.words.test.timings[0]),113);
});
test('a mistake on either letter counts against pair accuracy', () => {
  const s = core.analyze([e('cat',0,'x',0),e('cat',1,'a',100),e('cat',2,'t',200)]);
  assert.equal(s.pairs.ca.errors,1); assert.equal(s.pairs.at.errors,0);
  assert.deepEqual(s.pairs.ca.timings,[]);
});
test('long pauses and visibility breaks are excluded from clean timing', () => {
  const s = core.analyze([e('cat',0,'c',0),e('cat',1,'a',5000),e('cat',1,'',5050,'break'),e('cat',2,'t',5200)]);
  assert.deepEqual(s.pairs.ca.timings,[]); assert.deepEqual(s.pairs.at.timings,[]); assert.deepEqual(s.words.cat.timings,[]);
});
test('skipped letters count as first-pass failures but are not invented keypresses', () => {
  const s = core.analyze([e('cat',0,'c',0),e('cat',1,' ',100)]);
  assert.equal(s.chars.a.errors,1); assert.equal(s.chars.t.errors,1);
  assert.equal(s.pairs.at.errors,1); assert.equal(s.words.cat.errors,1); assert.equal(s.presses,2);
});
test('partial last word does not become a completed word observation', () => {
  const s = core.analyze([e('street',0,'s',0),e('street',1,'t',100)]);
  assert.equal(s.words.street,undefined); assert.equal(s.pairs.st.attempts,1);
});
test('pair timing does not cross word boundaries or word regressions', () => {
  const s = core.analyze([e('at',0,'a',0),e('at',1,'t',100),e('to',0,'t',200,'insert',1),e('to',1,'o',300,'insert',1),e('at',1,'t',400)]);
  assert.deepEqual(s.pairs.to.timings,[100]); assert.deepEqual(s.pairs.at.timings,[100]);
});
test('profiles separate languages, layouts, and abandoned sessions', () => {
  const s = simple(); const sessions = [s,{...s,id:'ru',language:'russian'},{...s,id:'alt',layout:'alternate'},{...s,id:'restart',status:'abandoned'}];
  const p = core.profile(sessions); assert.equal(p.sessions.length,1); assert.equal(p.totalPresses,s.presses);
  assert.equal(core.profile(sessions,{language:'russian'}).sessions.length,1);
});
test('small samples cannot produce automatic drill targets', () => {
  const s = core.analyze([e('cat',0,'c',0),e('cat',1,'x',100)]);
  const p = core.profile([s]); assert.equal(p.pairs[0].reliable,false);
  const drill = core.generate(p,['cat','street']); assert.equal(drill.targeted,false); assert.equal(drill.words.length,40);
});
test('targeted drills contain focus words and varied ordinary words', () => {
  const p = { pairs:[{key:'st',reliable:true,score:1}], words:[] };
  const drill = core.generate(p,['street','strong','start','world'],{random:()=>0.1});
  assert.equal(drill.words.length,40); assert.ok(drill.words.filter(w=>w.includes('st')).length >= 30);
  assert.ok(drill.words.every((w,i)=>i===0 || w!==drill.words[i-1]));
});
test('retention, duplicate imports, and strict backup validation', () => {
  const s = simple(); assert.ok(core.validateSession(s));
  assert.equal(core.mergeSessions([s],[s]).length,1);
  const merged = core.mergeSessions(Array.from({length:160},(_,i)=>({...s,id:`s${i}`,date:i})),[{...s,id:'new'}]);
  assert.equal(merged.length,160); assert.equal(merged.at(-1).id,'new');
  const backup = JSON.stringify({app:'keyloom',version:1,sessions:[s]});
  assert.equal(core.parseBackup(backup).length,1);
  assert.throws(()=>core.parseBackup('{"version":2,"sessions":[]}'));
  assert.throws(()=>core.mergeSessions([],[{...s,accuracy:NaN}]));
  assert.throws(()=>core.mergeSessions([],[{...s,chars:{a:{attempts:1,errors:2,timings:[]}}}]));
});
test('prototype-shaped keys cannot enter imported profiles', () => {
  const s = simple(); s.words = JSON.parse('{"__proto__":{"attempts":1,"errors":0,"timings":[]}}');
  assert.equal(core.validateSession(s),false);
});
test('demo data is isolated, valid, and produces meaningful profiles in both languages', () => {
  const samples = KeyloomDemo.sessions(); assert.ok(samples.every(core.validateSession));
  for (const language of ['english','russian']) {
    const p = core.profile(samples,{language}); assert.equal(p.sessions.length,12);
    assert.ok(p.pairs.some(r=>r.reliable && r.score>0));
    assert.equal(core.generate(p,KeyloomWords[language]).words.length,40);
  }
});
test('custom links round-trip Unicode and exact exercise settings', async () => {
  const sandbox = vm.createContext({});
  vm.runInContext(await readFile(new URL('../extension/vendor/lz-string.js',import.meta.url),'utf8'),sandbox);
  vm.runInContext(await readFile(new URL('../extension/practice.js',import.meta.url),'utf8'),sandbox);
  const url = new URL(sandbox.KeyloomPractice.url(['строка','ёжик','остров'],'russian'));
  assert.equal(url.origin,'https://monkeytype.com');
  const data = JSON.parse(sandbox.LZString.decompressFromEncodedURIComponent(url.searchParams.get('testSettings')));
  assert.equal(data[0],'custom'); assert.deepEqual(data[2].text,['строка','ёжик','остров']);
  assert.deepEqual(data[2].limit,{mode:'word',value:3}); assert.equal(data[5],'russian');
});
