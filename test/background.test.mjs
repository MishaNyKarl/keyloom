import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

async function harness() {
  const core = await readFile(new URL('../extension/core.js', import.meta.url), 'utf8');
  const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  const storage = { sessions: [], settings: { enabled: true, layout: 'default' } };
  let handler;
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, console, URL });
  const scripts = Object.fromEntries(await Promise.all(['core.js','analytics.js','vendor/lz-string.js','practice.js'].map(async name=>[name,await readFile(new URL('../extension/'+name,import.meta.url),'utf8')])));
  context.importScripts = (...names) => names.forEach(name=>vm.runInContext(scripts[name], context));
  const opened=[];
  context.chrome = {
    runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, onMessage: { addListener: fn => handler = fn } },
    storage: { local: { get: async () => structuredClone(storage), set: async values => Object.assign(storage, structuredClone(values)) } },
    tabs: { create: async options => {opened.push(options.url);return { id: 1 };} },
  };
  vm.runInContext(source, context);
  const send = (message, url = 'https://monkeytype.com/') => new Promise(resolve => {
    const keep = handler(message, { id: 'test-extension', url }, resolve);
    if (!keep) resolve(undefined);
  });
  const session = id => context.KeyloomCore.analyze([
    {target:'cat',wordIndex:0,position:0,typed:'c',type:'insert',time:0},
    {target:'cat',wordIndex:0,position:1,typed:'a',type:'insert',time:120},
    {target:'cat',wordIndex:0,position:2,typed:'t',type:'insert',time:230},
  ], {id});
  return { storage, send, session, opened, context };
}
test('concurrent tabs cannot overwrite each other or duplicate results', async () => {
  const {storage,send,session} = await harness();
  const responses = await Promise.all([send({type:'SAVE_SESSION',session:session('a')}),send({type:'SAVE_SESSION',session:session('b')}),send({type:'SAVE_SESSION',session:session('a')})]);
  assert.ok(responses.every(r=>r.ok)); assert.equal(storage.sessions.length,2);
});
test('disabled recording does not save; website cannot import or change settings', async () => {
  const {storage,send,session} = await harness();
  storage.settings.enabled = false;
  assert.equal((await send({type:'SAVE_SESSION',session:session('a')})).ignored,true);
  assert.equal(storage.sessions.length,0);
  assert.equal((await send({type:'SET_SETTINGS',settings:{enabled:true}})).ok,false);
  assert.equal((await send({type:'IMPORT',sessions:[session('a')]})).ok,false);
  assert.equal((await send({type:'GET_STATE'})).sessions.length,0);
});
test('invalid requests do not poison the serial storage queue', async () => {
  const {send,session,storage} = await harness();
  assert.equal((await send({type:'SAVE_SESSION',session:{id:'bad'}})).ok,false);
  assert.equal((await send({type:'SAVE_SESSION',session:session('valid')})).ok,true);
  assert.equal(storage.sessions.length,1);
});
test('unrelated origins are rejected; extension pages can read the full profile', async () => {
  const {send,session} = await harness();
  assert.equal(await send({type:'GET_STATE'},'https://example.com/'),undefined);
  await send({type:'SAVE_SESSION',session:session('a')});
  assert.equal((await send({type:'GET_STATE'},'chrome-extension://test-extension/dashboard.html')).sessions.length,1);
});

test('exercise is registered before launch and returned only for its matching link',async()=>{
 const h=await harness();const plan={id:'exercise-one',language:'english',layout:'default',kind:'pairs',seconds:60,words:Array(10).fill('cat'),targets:['ca']};
 assert.equal((await h.send({type:'START_PRACTICE',plan})).ok,false);
 assert.equal((await h.send({type:'START_PRACTICE',plan},'chrome-extension://test-extension/dashboard.html')).ok,true);
 assert.equal(h.storage.exercises.length,1);assert.equal(new URL(h.opened[0]).searchParams.get('keyloomExercise'),plan.id);
 assert.equal((await h.send({type:'GET_STATE'})).training,null);
 assert.equal((await h.send({type:'GET_STATE'},'https://monkeytype.com/?keyloomExercise=exercise-one')).training.id,plan.id);
 const result={...h.session('linked'),mode:'custom',training:{id:plan.id,kind:'pairs',seconds:60,targets:['forged']}};
 assert.equal((await h.send({type:'SAVE_SESSION',session:result},'https://monkeytype.com/?keyloomExercise=exercise-one')).ok,true);
 assert.deepEqual(h.storage.sessions[0].training.targets,['ca']);
 await h.send({type:'OPEN_DASHBOARD',sessionId:'linked'});
 assert.match(h.opened.at(-1),/session=linked&language=english#practice/);
 await h.send({type:'SAVE_SESSION',session:{...result,id:'unlinked'}});
 assert.equal(h.storage.sessions.find(s=>s.id==='unlinked').training,undefined);
});
test('disabled capture and invalid exercise never open a test tab',async()=>{
 const h=await harness();const url='chrome-extension://test-extension/dashboard.html';
 assert.equal((await h.send({type:'START_PRACTICE',plan:{}},url)).ok,false);
 h.storage.settings.enabled=false;
 assert.equal((await h.send({type:'START_PRACTICE',plan:{}},url)).ok,false);assert.equal(h.opened.length,0);
});
