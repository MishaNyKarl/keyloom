import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

async function harness(firefox = false) {
  const core = await readFile(new URL('../extension/core.js', import.meta.url), 'utf8');
  const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  const storage = { sessions: [], settings: { enabled: true, layout: 'default' } };
  let handler;
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder, AbortSignal, console, URL, structuredClone });
  const scripts = Object.fromEntries(await Promise.all(['core.js','analytics.js','learning.js','daily.js','words.js','vendor/lz-string.js','practice.js','sync.js'].map(async name=>[name,await readFile(new URL('../extension/'+name,import.meta.url),'utf8')])));
  context.importScripts = (...names) => names.forEach(name=>vm.runInContext(scripts[name], context));
  const opened=[], updated=[];
  context.chrome = {
    permissions: { contains: async () => true },
    runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, onMessage: { addListener: fn => handler = fn } },
    storage: { local: { get: async () => structuredClone(storage), set: async values => Object.assign(storage, structuredClone(values)) } },
    tabs: { update: async (id, options) => { updated.push({id, ...options}); }, create: async options => {opened.push(options.url);return { id: 1 };} },
  };
  if (firefox) {
    context.browser = context.chrome;
    context.browser.runtime.getURL = path => 'moz-extension://test-extension/' + path;
    delete context.chrome;
    delete context.importScripts;
    for (const name of ['core.js', 'analytics.js', 'learning.js', 'daily.js', 'words.js', 'vendor/lz-string.js', 'practice.js','sync.js']) {
      vm.runInContext(scripts[name], context);
    }
  }
  vm.runInContext(source, context);
  const send = (message, url = 'https://monkeytype.com/', tab = {id:7}) => new Promise(resolve => {
    const keep = handler(message, { id: 'test-extension', url, tab }, resolve);
    if (!keep) resolve(undefined);
  });
  const session = id => context.KeyloomCore.analyze([
    {target:'cat',wordIndex:0,position:0,typed:'c',type:'insert',time:0},
    {target:'cat',wordIndex:0,position:1,typed:'a',type:'insert',time:120},
    {target:'cat',wordIndex:0,position:2,typed:'t',type:'insert',time:230},
  ], {id});
  return { storage, send, session, opened, updated, context };
}
test('concurrent tabs cannot overwrite each other or duplicate results', async () => {
  const {storage,send,session} = await harness();
  const responses = await Promise.all([send({type:'SAVE_SESSION',session:session('a')}),send({type:'SAVE_SESSION',session:session('b')}),send({type:'SAVE_SESSION',session:session('a')})]);
  assert.ok(responses.every(r=>r.ok)); assert.equal(storage.sessions.length,2);
});

test('sync consent is extension-only, secrets stay private, failed sync preserves local results', async () => {
  const h = await harness(true);
  const page = 'moz-extension://test-extension/dashboard.html';
  const config = { url: 'https://192.0.2.1:8443', token: 'synthetic-token-with-at-least-32-characters' };
  h.context.fetch = async () => Response.json({ version: 1, total: 1, sessions: [h.session('remote')] });
  assert.equal((await h.send({ type: 'CONNECT_SYNC', config })).ok, false);
  assert.equal((await h.send({ type: 'CONNECT_SYNC', config }, page)).ok, true);
  assert.equal(h.storage.sessions[0].id, 'remote');
  for (const url of [page, 'https://monkeytype.com/']) {
    assert.equal(JSON.stringify(await h.send({ type: 'GET_STATE' }, url)).includes(config.token), false);
  }
  assert.equal((await h.send({ type: 'DISCONNECT_SYNC' })).ok, false);
  h.context.fetch = async () => { throw new Error('offline'); };
  await h.send({ type: 'SAVE_SESSION', session: h.session('offline') });
  const failed = await h.send({ type: 'SYNC_NOW' }, page);
  assert.equal(failed.synchronized, false);
  assert.equal(failed.errorCode, 'NETWORK_ERROR');
  assert.equal(h.storage.sessions.length, 2);
  assert.ok(h.storage.syncStatus.error);
  await h.send({ type: 'DISCONNECT_SYNC' }, page);
  assert.equal(h.storage.syncConfig, null);
  assert.equal(h.storage.sessions.length, 2);
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
 const h=await harness();const plan={id:'exercise-one',language:'english',layout:'default',kind:'pairs',seconds:60,words:Array(10).fill('cat'),wordCount:10,targets:['ca']};
 assert.equal((await h.send({type:'START_PRACTICE',plan})).ok,false);
 assert.equal((await h.send({type:'START_PRACTICE',plan},'chrome-extension://test-extension/dashboard.html')).ok,true);
 assert.equal(h.storage.exercises.length,1);assert.equal(new URL(h.opened[0]).searchParams.get('keyloomExercise'),plan.id);
 assert.equal((await h.send({type:'GET_STATE'})).training,null);
 assert.equal((await h.send({type:'GET_STATE'},'https://monkeytype.com/?keyloomExercise=exercise-one')).training.id,plan.id);
 const result={...h.session('linked'),mode:'custom',training:{id:plan.id,kind:'pairs',seconds:60,targets:['forged']}};
 assert.equal((await h.send({type:'SAVE_SESSION',session:result},'https://monkeytype.com/?keyloomExercise=exercise-one')).ok,true);
 assert.deepEqual(h.storage.sessions[0].training.targets,['ca']);
 assert.equal(h.storage.sessions[0].training.wordCount,10);
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

test('sequence exercise metadata survives background storage and dashboard return', async () => {
  const h = await harness();
  const plan = { id: 'sequence-test', language: 'english', layout: 'default', kind: 'sequences', seconds: 60, words: Array(10).fill('cat'), targets: ['cat'] };
  assert.equal((await h.send({ type: 'START_PRACTICE', plan }, 'chrome-extension://test-extension/dashboard.html')).ok, true);
  const session = { ...h.session('sequence-result'), mode: 'custom', training: { id: plan.id } };
  assert.equal((await h.send({ type: 'SAVE_SESSION', session }, 'https://monkeytype.com/?keyloomExercise=sequence-test')).ok, true);
  assert.equal(h.storage.sessions[0].training.kind, 'sequences');
  assert.equal(h.storage.sessions[0].sequences.cat.attempts, 1);
});

test('symbol exercises round-trip exact punctuation and save category-specific results', async () => {
  const h = await harness();
  const plan = {
    id: 'punctuation-test', language: 'russian', layout: 'default', kind: 'punctuation',
    seconds: 60, words: Array(10).fill('7,"'), targets: [',', '"']
  };
  const started = await h.send({ type: 'START_PRACTICE', plan }, 'chrome-extension://test-extension/dashboard.html');
  assert.equal(started.ok, true);
  const url = new URL(h.opened.at(-1));
  const decoded = JSON.parse(h.context.LZString.decompressFromEncodedURIComponent(url.searchParams.get('testSettings')));
  assert.deepEqual(decoded[2].text, plan.words);
  const session = h.context.KeyloomCore.analyze([...plan.words[0]].map((typed, position) => ({
    target: plan.words[0], typed, position, wordIndex: 0, type: 'insert', time: position * 100
  })), { id: 'punctuation-result', mode: 'custom', language: 'russian', training: { id: plan.id } });
  assert.equal((await h.send({ type: 'SAVE_SESSION', session }, url.toString())).ok, true);
  assert.equal(h.storage.sessions[0].training.kind, 'punctuation');
  assert.equal(h.storage.sessions[0].punctuation[','].attempts, 1);
});

test('Firefox event page saves results, opens its own dashboard and registers practice', async () => {
  const h = await harness(true);
  const page = 'moz-extension://test-extension/dashboard.html';
  assert.equal((await h.send({ type: 'GET_STATE' }, page)).ok, true);
  const responses = await Promise.all(['firefox-one', 'firefox-two'].map(id => h.send({ type: 'SAVE_SESSION', session: h.session(id) })));
  assert.ok(responses.every(result => result.saved));
  assert.equal(h.storage.sessions.length, 2);
  await h.send({ type: 'OPEN_DASHBOARD', sessionId: 'firefox-one' });
  assert.match(h.opened.at(-1), /^moz-extension:\/\/test-extension\/dashboard.html\?session=firefox-one/);
  const plan = { id: 'firefox-plan', language: 'english', layout: 'default', kind: 'pairs', seconds: 60, words: Array(10).fill('cat'), targets: ['ca'] };
  assert.equal((await h.send({ type: 'START_PRACTICE', plan }, page)).ok, true);
  assert.equal(new URL(h.opened.at(-1)).searchParams.get('keyloomExercise'), plan.id);
  assert.equal(await h.send({ type: 'GET_STATE' }, 'https://unrelated.example/'), undefined);
});

test('daily launch and completion persist, reject untrusted commands and ignore duplicate saves', async () => {
  const h = await harness();
  const page = 'chrome-extension://test-extension/dashboard.html';
  assert.equal((await h.send({type:'CREATE_DAILY',options:{}})).ok,false);
  const response = await h.send({type:'CREATE_DAILY',options:{languages:'english',repeat:false,repair:false,quote:false}},page);
  assert.equal(response.ok,true);
  const id = response.plan.id;
  assert.equal((await h.send({type:'START_DAILY',id},page)).ok,true);
  const url = h.opened.at(-1);
  const first = h.storage.dailies[0].steps[0];
  const completed = {...h.session('daily-result'),mode:'time',duration:60,date:first.startedAt+1};
  await Promise.all([h.send({type:'SAVE_SESSION',session:completed},url),h.send({type:'SAVE_SESSION',session:completed},url)]);
  assert.equal(h.storage.dailies[0].steps.filter(step=>step.result).length,1);
  await h.send({type:'OPEN_DASHBOARD',sessionId:completed.id},url);
  assert.ok(h.opened.at(-1).endsWith('#daily'));
  const state = await h.send({type:'GET_STATE'},page);
  assert.equal(state.dailies[0].steps[0].result.id,completed.id);
  assert.ok(state.learning.vocabulary['english:default'].includes('cat'));
  const fromPage = await h.send({type:'GET_STATE'},url);
  assert.equal(fromPage.learning,undefined);
  assert.equal(fromPage.dailies,undefined);
});

test('learning migration, old backup import and invalid learning import preserve existing data', async () => {
  const h = await harness();
  const page = 'chrome-extension://test-extension/dashboard.html';
  h.storage.sessions = [h.session('legacy')];
  const first = await h.send({type:'GET_STATE'},page);
  assert.ok(first.learning.vocabulary['english:default'].includes('cat'));
  h.storage.sessions = [];
  assert.ok((await h.send({type:'GET_STATE'},page)).learning.vocabulary['english:default'].includes('cat'));
  const original = JSON.stringify(h.storage);
  assert.equal((await h.send({type:'IMPORT',sessions:[h.session('other')],learning:{version:99}},page)).ok,false);
  assert.equal(JSON.stringify(h.storage),original);
  assert.equal((await h.send({type:'IMPORT',sessions:[h.session('old-backup')]},page)).ok,true);
});

for (const firefox of [false, true]) {
  test('daily continuation uses the same tab and rejects skips: ' + firefox, async () => {
    const h = await harness(firefox);
    const api = h.context[firefox ? 'browser' : 'chrome'];
    const page = api.runtime.getURL('dashboard.html');
    const {plan} = await h.send({type:'CREATE_DAILY', options:{languages:'english',
      repeat:false, repair:true, quote:false}}, page);
    await h.send({type:'START_DAILY', id:plan.id}, page);
    const url = h.opened.at(-1);
    assert.equal((await h.send({type:'NEXT_DAILY'}, url)).ok, false);
    const first = h.storage.dailies[0].steps[0];
    const session = {...h.session('next-result'), mode:'time', duration:60, date:first.startedAt+1};
    const saved = await h.send({type:'SAVE_SESSION', session}, url);
    assert.ok(saved.daily.nextLabel);
    assert.equal((await h.send({type:'NEXT_DAILY'}, url, null)).ok, false);
    assert.equal((await h.send({type:'NEXT_DAILY'}, 'https://monkeytype.com/')).ok, false);
    const update = api.tabs.update;
    api.tabs.update = async () => { throw new Error('Tab unavailable'); };
    assert.equal((await h.send({type:'NEXT_DAILY'}, url)).ok, false);
    assert.equal(h.storage.dailies[0].steps[1].startedAt, undefined);
    assert.equal(h.storage.dailies[0].steps[0].result.id, 'next-result');
    api.tabs.update = update;
    const replies = await Promise.all([h.send({type:'NEXT_DAILY'}, url), h.send({type:'NEXT_DAILY'}, url)]);
    assert.equal(replies.filter(row => row.ok).length, 1);
    assert.equal(h.updated.length, 1);
    assert.equal(h.updated[0].id, 7);
    assert.equal(h.opened.length, 1);
    assert.equal(new URL(h.updated[0].url).searchParams.get('keyloomStep'), plan.steps[1].id);
    assert.ok(new URL(h.updated[0].url).searchParams.get('keyloomExercise'));
    assert.equal((await h.send({type:'NEXT_DAILY'}, h.updated[0].url)).ok, false);
  });
}
