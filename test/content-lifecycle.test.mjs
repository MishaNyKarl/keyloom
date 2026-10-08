import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

// Executes the actual content script; only DOM and Chrome transport are simulated.
async function harness(training=null, firefox=false, daily=null, today=null, deferSave=false,
  resultMounted=true) {
  const source = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  const core = await readFile(new URL('../extension/core.js', import.meta.url), 'utf8');
  const callbacks = {}, frames = [], saves = [], documentListeners = [];
  let stateListener, keyboard, resolveSave;
  let storageSubscriptions = 0;
  let first, active, clock = 0, wordIndex=0, target='street';
  const observers = [];
  const reads = {layout:0, target:0, panel:0, queries:0, active:0};
  const messages=[];
  const element = () => ({ shown:true, style:{},textContent:'', attributes:new Map(), attributeWrites:0,
    closest(selector) { return selector === '.hidden' && !this.shown ? this : null; },
    getClientRects() { reads.layout++; return this.shown ? [1] : []; },
    addEventListener(name,cb){this[name]=cb;},
    setAttribute(name,value){this.attributeWrites++;this.attributes.set(name,value);},
    getAttribute(name){reads.panel++;return this.attributes.get(name) ?? null;},
    contains(node){for(let n=node;n;n=n.parentElement){if(n===this)return true;}return false;},
    append(){},prepend(){} });
  const typing = element(), result = element(), badge = element(), resultInfo = element(); result.shown = false;
  let input = {id:'wordsInput',value:' ',
    addEventListener(name, callback) { this[name] = callback; },
    removeEventListener(name, callback) { if (this[name] === callback) delete this[name]; }};
  callbacks.beforeinput = event => input.beforeinput?.(event);
  const newWord = () => {
    const index = wordIndex, text = target;
    const word = {getAttribute:()=> String(index), hasAttribute:()=>true,
      classList:{contains:name => name === 'active' && active === word},
      querySelectorAll:()=>{reads.target++;return [...text].map(textContent=>({textContent}));}};
    return word;
  };
  first = newWord();
  active = first;
  const root = {querySelector:selector=> {
    if (selector === '.word.active') { reads.active++; return active; }
    return first;
  },
    get firstElementChild(){return first;}};
  const notifications = element();
  const body = element(), page = element(), wrapper = element(), caret = element();
  page.parentElement = body;
  typing.parentElement = page; result.parentElement = page;
  wrapper.parentElement = typing; root.parentElement = wrapper;
  input.parentElement = wrapper;
  caret.parentElement = wrapper; notifications.parentElement = body;
  first.parentElement = root;
  const mode = {textContent:training?'custom':'words', getAttribute:()=>null};
  const created = [];
  let privacy = null;
  const doc = {body,hidden:false,
    addEventListener(name, cb) { documentListeners.push(name); callbacks[name]=cb; },
    createElement:()=> { const node = created.length ? element() : badge; created.push(node); return node; },
    querySelector(selector) { reads.queries++; if (selector.includes('privacy-policy.html')) return privacy; return ({'#words':root,'#typingTest':typing,'#result':resultMounted ? result : null,'#wordsInput':input,'#words .word.active':active,'[data-ui-element="notifications"]':notifications,'#result .stats .info .bottom':resultInfo})[selector] ?? null; },
    querySelectorAll:()=>[mode],
  };
  const context = vm.createContext({document:doc, URL, location:{pathname:'/',href:'https://monkeytype.com/?keyloomDaily=plan&keyloomStep=step'}, crypto:webcrypto, performance:{now:()=>clock+=100},
    getComputedStyle:()=>{reads.layout++;return {visibility:'visible'};},requestAnimationFrame:cb=>frames.push(cb),
    MutationObserver:class {
      constructor(cb){this.cb=cb;this.targets=new Map();observers.push(this);}
      observe(node,options){
        if(options.attributes===false && options.attributeFilter)throw new TypeError('Invalid observer options');
        this.targets.set(node,options);
      }
      disconnect(){this.targets.clear();}
    },
    KeyloomKeyboard:{create(options){keyboard=options;return {open(){}};}},
    KeyloomConfiguration:{selected:()=>true,read:()=>({ok:true})},
    chrome:{runtime:{id:'test-extension',onMessage:{addListener(callback){stateListener=callback;}},getManifest:()=>({version:'1.0.8'}),async sendMessage(message){
      messages.push(message);
      if(message.type==='GET_STATE') return {ok:true,settings:{enabled:true,layout:'default'},training,today};
      if(message.type==='SAVE_SESSION'){saves.push(message.session);if(deferSave)return new Promise(resolve=>{resolveSave=resolve;});return {ok:true,saved:true,daily};}
      return {ok:true};
    }},storage:{onChanged:{addListener(){storageSubscriptions++;}}}},
  });
  if (firefox) { context.browser = context.chrome; delete context.chrome; }
  vm.runInContext(core,context); vm.runInContext(source,context);
  // Cross-realm async transport needs a full microtask drain before typing.
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  const mutate = records => {
    for(const observer of observers){
      const matches=records.filter(record=>[...observer.targets].some(([node,options])=>
        (node===record.target || options.subtree && node.contains?.(record.target)) &&
        (record.type==='childList' ? options.childList : options.attributes &&
          (!options.attributeFilter || options.attributeFilter.includes(record.attributeName)))));
      if(matches.length)observer.cb(matches);
    }
  };
  const changed = async (records=[{target:typing,type:'attributes',attributeName:'class'}]) => {
    mutate(records); while(frames.length) frames.shift()(); await settle();
  };
  const type = text => { for(const typed of text){callbacks.beforeinput({target:input,isTrusted:true,inputType:'insertText',data:typed,timeStamp:clock+=100});input.value+=typed;} };
  return {get keyboard(){return keyboard;},typing,result,badge,get input(){return input;},saves,type,changed,context,messages,mode,created,
    reads, frames, mutate, root, caret, notifications, callbacks, page, observers, resultInfo, documentListeners,
    resolveSave(reply) { resolveSave(reply); },
    mountResult() { resultMounted = true; },
    replaceInput() {
      const old = input;
      input = {...input, value:' '};
      old.isConnected = false;
      input.isConnected = true;
      delete input.beforeinput;
      return old;
    },
    mountFooter() {
      privacy = {nextElementSibling:null, after(node){this.nextElementSibling=node;}};
      return privacy;
    },
    get storageSubscriptions(){return storageSubscriptions;},
    notifyState(message, id='test-extension') {
      stateListener({type:'KEYLOOM_STATE_CHANGED',...message},{id});
    },
    changeTheme(theme){stateListener({type:'KEYLOOM_STATE_CHANGED',theme},{id:'test-extension'});},
    nextWord(index,text='street'){wordIndex=index;target=text;input.value=' ';active=newWord();active.parentElement=root;if(index===0)first=active;},
    async clickBadge(){badge.click();await settle();},
    replaceWord(){wordIndex=0;first=newWord();active=first;first.parentElement=root;input.value=' ';},
    removeFirstLine(){first=active;},
    async clickRestart(){callbacks.click({target:{closest:()=>true}});await settle();},
  };
}

for (const page of ['account', 'home']) {
  test('Alt+N resumes today after leaving test markers: ' + page, async () => {
    const h = await harness(null, false, {completed:false}, {done:3, total:30});
    h.type('street');
    h.typing.shown = false;
    h.result.shown = true;
    await h.changed();
    h.context.location.pathname = page === 'account' ? '/account' : '/';
    h.context.location.href = 'https://monkeytype.com' + h.context.location.pathname;
    const next = h.keyboard.commands.find(command => command.key === 'KeyN');
    assert.equal(next.available(), true);
    await next.run();
    assert.equal(h.messages.at(-1).type, 'RESUME_TODAY');
    assert.equal(h.messages.at(-1).pageUrl, undefined);
    assert.equal(h.messages.some(message => message.type === 'NEXT_DAILY'), false);
    assert.doesNotMatch(h.badge.textContent, /Не удалось/);
  });
}

test('initial state on account does not send a test-only page URL', async () => {
  const h = await harness();
  h.context.location.pathname = '/account';
  h.context.location.href = 'https://monkeytype.com/account';
  // Reload the actual adapter, simulating a document initially opened on /account.
  h.context.__keyloomLoaded = false;
  vm.runInContext(await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'), h.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.messages.filter(message => message.type === 'GET_STATE').at(-1).pageUrl, undefined);
});

test('capture is field-bound and replacement binds before the queued frame', async () => {
  const h = await harness();
  assert.equal(h.documentListeners.includes('beforeinput'), false);
  const old = h.replaceInput();
  h.mutate([{target:h.input.parentElement, type:'childList'}]);
  assert.equal(old.beforeinput, undefined);
  assert.equal(typeof h.input.beforeinput, 'function');
  // No lifecycle RAF has run; first input still starts a complete session.
  h.type('street');
  h.typing.shown = false;
  h.result.shown = true;
  await h.changed();
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].presses, 6);
});

test('steady trusted input uses event timestamps even with passive diagnostics', async () => {
  const h = await harness();
  h.keyboard.commands.find(row => row.label === 'Включить диагностику').run();
  h.callbacks.beforeinput({target:h.input, isTrusted:true, inputType:'insertText', data:'s', timeStamp:1000});
  h.input.value += 's';
  const now = h.context.performance.now;
  h.context.performance.now = () => { throw new Error('Hot path must not read the clock'); };
  h.callbacks.beforeinput({target:{id:'wordsInput',value:' '}, isTrusted:true,
    inputType:'insertText', data:'x', timeStamp:1050});
  h.callbacks.beforeinput({target:h.input, isTrusted:false,
    inputType:'insertText', data:'x', timeStamp:1050});
  h.callbacks.beforeinput({target:h.input, isTrusted:true,
    inputType:'insertText', data:'t', timeStamp:1100});
  h.input.value += 't';
  h.context.performance.now = now;
  h.typing.shown = false;
  h.result.shown = true;
  await h.changed();
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].presses, 2);
  assert.equal(h.saves[0].duration, .1);
});

test('passive diagnostics exports counters without timers or input/route identifiers', async () => {
  const h = await harness();
  const timers = [];
  const blobs = [];
  class ReportURL extends URL {
    static createObjectURL(blob) { blobs.push(blob); return 'blob:report'; }
    static revokeObjectURL() {}
  }
  h.context.URL = ReportURL;
  h.context.Blob = Blob;
  h.context.setTimeout = callback => timers.push(callback);
  const create = h.context.document.createElement;
  const downloads = [];
  h.context.document.createElement = tag => {
    const node = create(tag);
    node.click = () => downloads.push(node.download);
    return node;
  };
  const command = label => h.keyboard.commands.find(row => row.label === label);
  assert.equal(command('Скачать диагностику').available(), false);
  command('Включить диагностику').run();
  assert.equal(timers.length, 0);
  h.type('street');
  h.typing.shown = false;
  h.result.shown = true;
  await h.changed();
  h.context.document.hidden = true;
  h.callbacks.visibilitychange();
  h.context.document.hidden = false;
  h.callbacks.visibilitychange();
  command('Скачать диагностику').run();
  const serialized = await blobs[0].text();
  const report = JSON.parse(serialized);
  assert.equal(report.format, 2);
  assert.equal(report.captureTiming, 'not-measured');
  assert.equal(report.eventLoopSampling, false);
  assert.equal(report.metrics.inputEvents.count, 6);
  assert.equal(report.metrics.activeWordQueries.count, 1);
  assert.equal(report.metrics.analysis.count, 1);
  assert.equal(report.metrics.eventLoopDelay, undefined);
  assert.equal(timers.length, 1); // Only deferred Blob URL cleanup after download.
  assert.equal(report.tests[0].saved, true);
  assert.deepEqual(downloads, ['keyloom-diagnostics.json']);
  assert.doesNotMatch(serialized, /street|monkeytype\.com|keyloomDaily|keyloomStep|pageUrl/);
  command('Выключить диагностику').run();
  assert.equal(command('Скачать диагностику').available(), true);
  const pending = timers.length;
  timers.shift()();
  assert.equal(timers.length, pending - 1);
});
test('normal completion survives the interval where both panels are hidden',async()=>{
  const h=await harness();h.type('street');h.typing.shown=false;
  for(let i=0;i<20;i++) await h.changed();
  assert.equal(h.saves.length,0); assert.match(h.badge.textContent,/Ожидаю результаты/);
  h.result.shown=true;await h.changed();await h.changed();
  assert.equal(h.saves.length,1);assert.equal(h.saves[0].status,'completed');
});

test('in-place next updates exercise and URL before accepting the next trusted test', async () => {
  const h = await harness(null, false, {nextLabel:'next', completed:false});
  const send = h.context.chrome.runtime.sendMessage;
  const training = {id:'next-exercise', words:Array(10).fill('street'), wordCount:10,
    language:'english', layout:'default', kind:'words', targets:[], seconds:30};
  const url = 'https://monkeytype.com/?keyloomDaily=plan&keyloomStep=next&keyloomExercise=next-exercise';
  h.context.chrome.runtime.sendMessage = message => message.type === 'NEXT_DAILY' ?
    Promise.resolve({ok:true, url, training, testSettings:[]}) : send(message);
  h.context.history = {replaceState(state, title, value) {h.context.location.href = value;}};
  h.context.KeyloomConfiguration.prepare = async () => () => {
    assert.equal(h.context.location.href, url);
    h.mode.textContent = 'custom';
    h.replaceWord();
    h.typing.shown = true;
    h.result.shown = false;
  };
  h.type('street');
  h.typing.shown = false;
  h.result.shown = true;
  await h.changed();
  await h.keyboard.commands.find(command => command.key === 'KeyN').run();
  for (let index = 0; index < 10; index++) {
    h.nextWord(index);
    h.type('street');
  }
  h.typing.shown = false;
  h.result.shown = true;
  await h.changed();
  assert.equal(h.saves.length, 2);
  assert.equal(h.saves[1].training.id, training.id);
});

test('saving uses the route captured at test start even after a later URL change', async () => {
  const h = await harness();
  const original = h.context.location.href;
  h.type('street');
  h.context.location.href = 'https://monkeytype.com/?keyloomDaily=plan&keyloomStep=later';
  h.typing.shown = false;
  h.result.shown = true;
  await h.changed();
  const saved = h.messages.find(message => message.type === 'SAVE_SESSION');
  assert.equal(saved.pageUrl, original);
  assert.equal(saved.session.pageUrl, undefined);
});

for (const failure of ['history', 'silent-start']) {
  test('next falls back to the prepared URL when in-place launch fails: ' + failure, async () => {
    const h = await harness(null, false, {nextLabel:'next', completed:false});
    const send = h.context.chrome.runtime.sendMessage;
    const url = 'https://monkeytype.com/?keyloomDaily=plan&keyloomStep=next';
    const navigations = [];
    h.context.location.assign = value => navigations.push(value);
    h.context.history = {replaceState(state, title, value) {
      if (failure === 'history') {
        throw new Error('URL update rejected');
      }
      h.context.location.href = value;
    }};
    // Deterministic host transition clock: the result panel never disappears.
    h.context.setTimeout = resolve => queueMicrotask(resolve);
    h.context.KeyloomConfiguration.prepare = async () => () => {};
    h.context.chrome.runtime.sendMessage = message => message.type === 'NEXT_DAILY' ?
      Promise.resolve({ok:true, url, testSettings:[]}) : send(message);
    h.type('street');
    h.typing.shown = false;
    h.result.shown = true;
    await h.changed();
    await h.keyboard.commands.find(command => command.key === 'KeyN').run();
    assert.deepEqual(navigations, [url]);
    assert.equal(h.saves.length, 1);
    assert.equal(h.saves[0].status, 'completed');
  });
}
test('word DOM replacement during the hidden transition is not a restart',async()=>{
  const h=await harness();h.type('street');h.typing.shown=false;h.replaceWord();await h.changed();
  assert.equal(h.saves.length,0);
  h.result.shown=true;await h.changed();assert.equal(h.saves[0].status,'completed');
});
test('a new ready test with replaced words still abandons the old test',async()=>{
  const h=await harness();h.type('str');h.replaceWord();await h.changed();
  assert.equal(h.saves.length,1);assert.equal(h.saves[0].status,'abandoned');
});
test('explicit restart while typing remains abandoned',async()=>{
  const h=await harness();h.type('str');await h.clickRestart();
  assert.equal(h.saves[0].status,'abandoned');
});
test('restart click after results become visible preserves completed status',async()=>{
  const h=await harness();h.type('street');h.typing.shown=false;h.result.shown=true;
  await h.clickRestart();await h.changed();assert.equal(h.saves.length,1);assert.equal(h.saves[0].status,'completed');
});
test('navigation away is distinct from a transition within the test page',async()=>{
  const h=await harness();h.type('str');h.typing.shown=false;h.context.location.pathname='/settings';await h.changed();
  assert.equal(h.saves[0].status,'abandoned');
});
test('completion of a timed test does not require typing the whole last word',async()=>{
  const h=await harness();h.type('str');h.typing.shown=false;await h.changed();
  h.result.shown=true;await h.changed();assert.equal(h.saves[0].status,'completed');
});

test('linked completion retains its exercise and badge opens that exact saved result',async()=>{
 const training={id:'exercise-one',words:Array(10).fill('street'),wordCount:10,language:'english',layout:'default',kind:'pairs',targets:['st'],seconds:60};
 const h=await harness(training);
 for(let i=0;i<10;i++){h.nextWord(i);h.type('street');}
 h.typing.shown=false;h.result.shown=true;await h.changed();
 assert.equal(h.saves[0].training.id,training.id);
 assert.equal(h.saves[0].training.wordCount,10);
 await h.clickBadge();assert.equal(h.messages.at(-1).type,'OPEN_DASHBOARD');assert.equal(h.messages.at(-1).sessionId,h.saves[0].id);
});
test('changed custom words cannot be credited to the linked exercise',async()=>{
 const training={id:'exercise-one',words:Array(10).fill('street'),wordCount:10,language:'english',layout:'default',kind:'pairs',targets:['st'],seconds:60};
 const h=await harness(training);h.type('street');h.nextWord(9,'strong');h.type('strong');
 h.typing.shown=false;h.result.shown=true;await h.changed();assert.equal(h.saves[0].training,undefined);
});
test('shortened custom test is saved but not credited as the full exercise',async()=>{
 const training={id:'exercise-one',words:Array(10).fill('street'),wordCount:10,language:'english',layout:'default',kind:'pairs',targets:['st'],seconds:60};
 const h=await harness(training);h.type('street');h.typing.shown=false;h.result.shown=true;await h.changed();
 assert.equal(h.saves[0].status,'completed');assert.equal(h.saves[0].training,undefined);
});

test('quote capture accepts capitalized words, digits and punctuation through normal completion', async () => {
  const h = await harness();
  h.mode.textContent = 'quote';
  h.nextWord(0, 'Привет,'); h.type('Привет,');
  h.nextWord(1, '2026!'); h.type('2026!');
  h.typing.shown = false; h.result.shown = true;
  await h.changed();
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].status, 'completed');
  assert.equal(h.saves[0].mode, 'quote');
  assert.equal(h.saves[0].language, 'russian');
  assert.equal(h.saves[0].uppercase.П.attempts, 1);
  assert.equal(h.saves[0].digits['2'].attempts, 2);
  assert.equal(h.saves[0].punctuation[','].attempts, 1);
  assert.equal(h.saves[0].punctuation['!'].attempts, 1);
});

test('Firefox browser namespace supports capture and result navigation without chrome', async () => {
  const h = await harness(null, true);
  h.type('street');
  h.typing.shown = false;
  h.result.shown = true;
  await h.changed();
  assert.equal(h.saves[0].status, 'completed');
  await h.clickBadge();
  assert.equal(h.messages.at(-1).sessionId, h.saves[0].id);
});

test('explicit app button opens overview without a training result', async () => {
  const h = await harness();
  const button = h.created.find(node => node.id === 'keyloom-open-app');
  assert.ok(button);
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.messages.at(-1).type, 'OPEN_DASHBOARD');
  assert.equal(h.messages.at(-1).sessionId, undefined);
});

test('next lesson appears after save and double click sends one command', async () => {
  const h = await harness(null, false, {nextLabel:'Repair', completed:false});
  const button = h.created.find(node => node.id === 'keyloom-next-step');
  assert.equal(button.hidden, true);
  h.type('street');
  assert.equal(button.hidden, true);
  h.typing.shown = false;
  h.result.shown = true;
  await h.changed();
  assert.equal(button.hidden, false);
  assert.equal(button.title, 'Repair');
  await button.click();
  await button.click();
  assert.equal(h.messages.filter(row => row.type === 'NEXT_DAILY').length, 1);
  assert.equal(button.disabled, true);
});
test('last lesson displays completion and hides continuation', async () => {
  const h = await harness(null, true, {completed:true});
  h.type('street');
  h.typing.shown = false;
  h.result.shown = true;
  await h.changed();
  assert.match(h.badge.textContent, /план завершён/);
  assert.equal(h.created.find(node => node.id === 'keyloom-next-step').hidden, true);
});

test('completed comparison is not rendered on Monkeytype', async () => {
  const h = await harness(null,false,{completed:true,comparisons:[{language:'english',
    before:30,after:25,saved:5,beforeAccuracy:99,afterAccuracy:98}]});
  h.type('street');
  h.typing.shown=false;
  h.result.shown=true;
  await h.changed();
  const note=h.created.find(node=>node.id==='keyloom-daily-comparison');
  assert.equal(note, undefined);
});

test('theme changes during typing preserve the complete captured session', async () => {
  const h=await harness();
  h.type('str');
  h.changeTheme('repose-dark');
  h.type('eet');
  h.typing.shown=false;
  h.result.shown=true;
  await h.changed();
  assert.equal(h.saves.length,1);
  assert.equal(h.saves[0].status,'completed');
  assert.equal(h.saves[0].presses,6);
});

test('keyboard continuation shares button safeguards and is unavailable during typing', async () => {
  const h=await harness(null,false,{nextLabel:'Repair',completed:false});
  h.type('street');
  assert.equal(h.keyboard.canOpen(),false);
  h.typing.shown=false;h.result.shown=true;
  await h.changed();
  assert.equal(h.keyboard.canOpen(),true);
  const next=h.keyboard.commands.find(command=>command.key==='KeyN');
  assert.equal(next.available(),true);
  await next.run();
  assert.equal(next.available(),false);
  assert.equal(h.messages.filter(message=>message.type==='NEXT_DAILY').length,1);
});

test('persistent controls stay separate from privacy and become inert during typing', async () => {
  const h = await harness();
  const widget = h.created.find(node => node.id === 'keyloom-widget');
  const progress = h.created.find(node => node.id === 'keyloom-progress');
  const privacy = h.mountFooter();
  await h.changed();
  assert.equal(privacy.nextElementSibling, null);
  assert.equal(widget.open, undefined);
  h.type('st');
  assert.equal(widget.open, undefined);
  assert.equal(widget.inert, true);
  assert.equal(widget.getAttribute('data-typing'), 'true');
  assert.equal(progress.getAttribute('data-typing'), 'true');
  h.typing.shown = false;
  h.result.shown = true;
  await h.changed();
  assert.equal(widget.inert, false);
  assert.equal(widget.getAttribute('data-typing'), 'false');
  assert.equal(progress.getAttribute('data-typing'), 'false');
});

test('only the known result ad spacer is marked, once after typing ends', async () => {
  const h = await harness();
  const attributes = new Map();
  let writes = 0;
  let wide = true;
  const spacer = {classList:{contains:name => wide && name === 'full-width'},
    getAttribute:name => attributes.get(name) ?? null,
    setAttribute(name, value) { writes++; attributes.set(name, value); }};
  const query = h.context.document.querySelector;
  h.context.document.querySelector = selector => selector === '#ad-result-wrapper' ?
    {parentElement:spacer} : query(selector);
  h.type('street');
  assert.equal(writes, 0);
  h.typing.shown = false;
  h.result.shown = true;
  await h.changed();
  await h.changed();
  assert.equal(attributes.get('data-keyloom-result-ad'), 'true');
  assert.equal(writes, 1);
  attributes.clear();
  wide = false;
  await h.changed();
  assert.equal(writes, 1);
});

test('content CSS avoids relational subtree selectors and removes typing widgets from rendering', async () => {
  const css = await readFile(new URL('../extension/keyboard.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /:has\(/);
  assert.match(css, /#keyloom-widget\[data-typing=true\],\s*#keyloom-progress\[data-typing=true\]\s*\{\s*display:\s*none;/);
});

test('today plan badge shows counts and estimated minutes without a linked test', async () => {
  const h = await harness(null, false, null, {done:3,total:12,minutes:8});
  const badge = h.created.find(node => node.id === 'keyloom-progress');
  assert.equal(badge.hidden, false);
  assert.match(badge.textContent, /3 \/ 12 заданий/);
  assert.match(badge.textContent, /≈ 8 мин/);
  const empty = await harness();
  assert.equal(empty.created.find(node => node.id === 'keyloom-progress').hidden, true);
});

test('daily menu labels reflect absent, unstarted and completed plans', async () => {
  for (const [today, label] of [
    [null, 'Составить сегодняшний план'],
    [{done:0,total:24,minutes:20}, 'Продолжить сегодняшний план'],
    [{done:24,total:24,minutes:0}, 'Составить сегодняшний план']
  ]) {
    const h = await harness(null, false, null, today);
    const command = h.keyboard.commands.find(command => command.alias.includes('daily plan'));
    assert.equal(command.label, label);
    await command.run();
    assert.equal(h.messages.at(-1).type, 'RESUME_TODAY');
  }
});

test('typing and caret updates do not rewrite unchanged panel attributes', async () => {
  const h = await harness();
  h.type('s');
  const writes = () => h.created.reduce((sum, node) => sum + node.attributeWrites, 0);
  const before = writes();
  h.type('treet');
  for (let i = 0; i < 5; i++) await h.changed();
  assert.equal(writes(), before);
  assert.equal(h.keyboard.hidePointer ?? false, false);
});

for (const firefox of [false, true]) {
  test('early next intent waits for completion and successful persistence: ' + firefox, async () => {
    const h = await harness(null, firefox, null, null, true);
    const next = h.keyboard.commands.find(command => command.key === 'KeyN');
    h.type('street');
    assert.equal(next.available(), false);
    h.typing.shown = false;
    await h.changed();
    assert.equal(next.canRunWhenBlocked(), true);
    await next.run();
    await next.run();
    assert.equal(h.messages.some(message => message.type === 'NEXT_DAILY'), false);
    h.result.shown = true;
    await h.changed();
    assert.equal(h.messages.some(message => message.type === 'NEXT_DAILY'), false);
    h.resolveSave({ok:true, saved:true, dailyStep:'completed', daily:{nextLabel:'Next',completed:false}});
    await h.changed();
    assert.equal(h.messages.filter(message => message.type === 'NEXT_DAILY').length, 1);
  });
}

test('queued next is discarded on failed, mismatched, final or restarted tests', async () => {
  for (const scenario of ['failure','mismatch','final','restart','restartWithoutTyping']) {
    const h = await harness(null, false, null, null, true);
    h.type('street'); h.typing.shown = false; h.result.shown = true;
    await h.changed();
    await h.keyboard.commands.find(command => command.key === 'KeyN').run();
    if (scenario.startsWith('restart')) {
      h.result.shown = false; h.typing.shown = true; h.replaceWord(); await h.changed();
      if (scenario === 'restart') h.type('str');
    }
    h.resolveSave(scenario === 'failure' ? {ok:false,error:'offline'} :
      {ok:true,saved:true,dailyStep:scenario === 'mismatch' ? 'mismatch' : 'completed',
        daily:{nextLabel:'Next',completed:scenario === 'final'}});
    await h.changed();
    assert.equal(h.messages.some(message => message.type === 'NEXT_DAILY'), false, scenario);
  }
});

test('steady typing does not read layout, reread letters or touch the panel', async () => {
  const h = await harness();
  h.type('s');
  const before = {...h.reads};
  h.type('treet');
  assert.equal(h.reads.layout, before.layout);
  assert.equal(h.reads.target, before.target);
  assert.equal(h.reads.panel, before.panel);
  assert.equal(h.reads.active, before.active);
  assert.equal(h.frames.length, 0);
  h.nextWord(1, 'strong'); h.type('strong');
  assert.equal(h.reads.target, before.target + 1);
  assert.equal(h.reads.layout, before.layout);
  h.typing.shown = false; h.result.shown = true; await h.changed();
  assert.equal(h.saves[0].presses, 12);
  assert.equal(h.saves[0].words.strong.attempts, 1);
});

test('caret animation, letter classes and unrelated subtrees schedule no work', async () => {
  const h = await harness(); h.type('s');
  const letter = {parentElement:h.root.querySelector('.word.active')};
  const before = {...h.reads};
  const unrelated = {parentElement:h.context.document.body};
  for (let i = 0; i < 100; i++) {
    h.mutate([{target:h.caret,type:'attributes',attributeName:'style'},
      {target:letter,type:'attributes',attributeName:'class'},
      {target:unrelated,type:'childList',addedNodes:[]}]);
  }
  assert.equal(h.frames.length, 0);
  assert.deepEqual(h.reads, before);
});

test('lazy result mounting leaves no document subtree observer during typing', async () => {
  const h = await harness(null, true, null, null, false, false);
  h.type('s');
  const letter = {parentElement:h.root.querySelector('.word.active')};
  const before = {...h.reads};
  for (let index = 0; index < 100; index++) {
    h.mutate([{target:letter, type:'childList', addedNodes:[]}]);
  }
  assert.equal(h.frames.length, 0);
  assert.deepEqual(h.reads, before);
  assert.equal(h.observers.some(observer =>
    observer.targets.get(h.context.document.body)?.subtree), false);
  h.type('treet');
  h.typing.shown = false;
  h.result.shown = true;
  h.mountResult();
  await h.changed([{target:h.page, type:'childList', addedNodes:[h.result]}]);
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].status, 'completed');
  assert.equal(h.saves[0].presses, 6);
});

test('ancestor opacity animation schedules no layout work but display changes finish a test', async () => {
  const h = await harness();
  h.type('street');
  const before = {...h.reads};
  h.typing.attributes.set('style', 'opacity: 0.95; font-size: 2rem');
  for (let index = 0; index < 100; index++) {
    h.mutate([{target:h.typing, type:'attributes', attributeName:'style',
      oldValue:'opacity: 1; font-size: 2rem'}]);
  }
  assert.equal(h.frames.length, 0);
  assert.equal(h.reads.layout, before.layout);
  h.typing.attributes.set('style', 'display: none;');
  h.typing.shown = false;
  h.result.shown = true;
  await h.changed([{target:h.typing, type:'attributes', attributeName:'style',
    oldValue:'opacity: 0.95; font-size: 2rem'}]);
  assert.equal(h.saves[0].status, 'completed');
});

test('word restart before the next animation frame does not mix sessions', async () => {
  const h = await harness(); h.type('str');
  h.replaceWord();
  h.mutate([{target:h.root,type:'childList',addedNodes:[]}]);
  h.type('street');
  h.typing.shown = false; h.result.shown = true; await h.changed();
  assert.deepEqual(h.saves.map(row => [row.status,row.presses]),
    [['abandoned',3],['completed',6]]);
});

test('performance abort is not credited and cancels a queued next lesson', async () => {
  const h = await harness(null, true, {completed:false,nextLabel:'Next'});
  h.type('street'); h.typing.shown = false; await h.changed();
  await h.keyboard.commands.find(command => command.key === 'KeyN').run();
  await h.changed([{type:'childList',target:h.notifications,
    addedNodes:[{textContent:'Stopping the test due to bad performance.'}]}]);
  h.result.shown = true; await h.changed();
  assert.equal(h.saves[0].status, 'abandoned');
  assert.equal(h.messages.some(message => message.type === 'NEXT_DAILY'), false);
  assert.match(h.badge.textContent, /Monkeytype.*производительност/);
  h.result.shown = false; h.typing.shown = true; h.replaceWord(); await h.changed();
  h.type('street'); h.typing.shown = false; h.result.shown = true; await h.changed();
  assert.equal(h.saves[1].status, 'completed');
});

test('failed and bailed-out result screens preserve an abandoned session', async () => {
  for (const info of ['failed (slow timer)', 'failed (minimum accuracy)', 'bailed out', 'afk detected']) {
    const h = await harness(); h.type('street');
    h.resultInfo.textContent = info;
    h.typing.shown = false; h.result.shown = true; await h.changed();
    assert.equal(h.saves[0].status, 'abandoned', info);
    assert.equal(h.keyboard.commands.find(command => command.key === 'KeyN').available(), false);
  }
  // Repeating the known baseline text is intentional in daily warmup/cooldown.
  const h = await harness(); h.type('street');
  h.resultInfo.textContent = 'invalidrepeated';
  h.typing.shown = false; h.result.shown = true; await h.changed();
  assert.equal(h.saves[0].status, 'completed');
});

test('removing old lines does not trigger layout reads on subsequent letters', async () => {
  const h = await harness(); h.type('street');
  h.nextWord(10); h.removeFirstLine();
  await h.changed([{target:h.root,type:'childList',addedNodes:[]}]);
  const before = h.reads.layout;
  h.type('street');
  assert.equal(h.reads.layout, before);
  h.typing.shown = false; h.result.shown = true; await h.changed();
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].status, 'completed');
});

test('typing page uses compact state messages without subscribing to storage histories', async () => {
  const h = await harness();
  assert.equal(h.storageSubscriptions,0);
  h.type('str');
  const before = h.messages.length;
  h.notifyState({today:{done:4,total:30,minutes:18}});
  h.type('eet');
  h.typing.shown=false;h.result.shown=true;
  await h.changed();
  assert.equal(h.saves.length,1);
  assert.equal(h.saves[0].status,'completed');
  assert.equal(h.messages.slice(before).filter(row=>row.type==='GET_TODAY_PROGRESS').length,0);
  assert.ok(h.created.some(node=>node.textContent.includes('4 / 30')));
});

test('state notifications enforce sender and settings while keeping pause behavior', async () => {
  const h = await harness();
  h.notifyState({settings:{enabled:false,layout:'default'}},'another-extension');
  h.type('str');
  h.notifyState({settings:{enabled:false,layout:'default'}});
  h.type('eet');
  h.typing.shown=false;h.result.shown=true;
  await h.changed();
  assert.equal(h.saves.length,0);
  h.notifyState({settings:{enabled:true,layout:'default'}});
  h.typing.shown=true;h.result.shown=false;h.replaceWord();
  await h.changed();h.type('street');
  h.typing.shown=false;h.result.shown=true;
  await h.changed();
  assert.equal(h.saves.length,1);
});
