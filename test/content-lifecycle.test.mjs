import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

// Executes the actual content script; only DOM and Chrome transport are simulated.
async function harness(training=null, firefox=false, daily=null) {
  const source = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  const core = await readFile(new URL('../extension/core.js', import.meta.url), 'utf8');
  const callbacks = {}, frames = [], saves = [];
  let storageListener, keyboard;
  let observer, first, clock = 0, wordIndex=0, target='street';
  const messages=[];
  const element = () => ({ shown:true, style:{},textContent:'',
    closest(selector) { return selector === '.hidden' && !this.shown ? this : null; },
    getClientRects() { return this.shown ? [1] : []; },
    addEventListener(name,cb){this[name]=cb;},setAttribute(){},contains(){return false;},append(){} });
  const typing = element(), result = element(), badge = element(); result.shown = false;
  const input = {id:'wordsInput',value:' '};
  const newWord = () => ({ getAttribute:()=> String(wordIndex), hasAttribute:()=>true,
    querySelectorAll:()=>[...target].map(textContent=>({textContent})) });
  first = newWord();
  const root = {querySelector:()=>first};
  const mode = {textContent:training?'custom':'words', getAttribute:()=>null};
  const created = [];
  let privacy = null;
  const doc = {body:{append(){}},hidden:false,
    addEventListener(name, cb) { callbacks[name]=cb; },
    createElement:()=> { const node = created.length ? element() : badge; created.push(node); return node; },
    querySelector(selector) { if (selector.includes('privacy-policy.html')) return privacy; return ({'#words':root,'#typingTest':typing,'#result':result,'#wordsInput':input,'#words .word.active':first})[selector] ?? null; },
    querySelectorAll:()=>[mode],
  };
  const context = vm.createContext({document:doc, location:{pathname:'/'}, crypto:webcrypto, performance:{now:()=>clock+=100},
    getComputedStyle:()=>({visibility:'visible'}),requestAnimationFrame:cb=>frames.push(cb),
    MutationObserver:class {constructor(cb){observer=cb;}observe(){}},
    KeyloomKeyboard:{create(options){keyboard=options;return {open(){}};}},
    KeyloomConfiguration:{selected:()=>true,read:()=>({ok:true})},
    chrome:{runtime:{async sendMessage(message){
      messages.push(message);
      if(message.type==='GET_STATE') return {ok:true,settings:{enabled:true,layout:'default'},training};
      if(message.type==='SAVE_SESSION'){saves.push(message.session);return {ok:true,saved:true,daily};}
      return {ok:true};
    }},storage:{onChanged:{addListener(callback){storageListener=callback;}}}},
  });
  if (firefox) { context.browser = context.chrome; delete context.chrome; }
  vm.runInContext(core,context); vm.runInContext(source,context);
  // Cross-realm async transport needs a full microtask drain before typing.
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  const changed = async () => { observer([{target:typing}]); while(frames.length) frames.shift()(); await settle(); };
  const type = text => { for(const typed of text){callbacks.beforeinput({target:input,isTrusted:true,inputType:'insertText',data:typed});input.value+=typed;} };
  return {get keyboard(){return keyboard;},typing,result,badge,input,saves,type,changed,context,messages,mode,created,
    mountFooter() {
      privacy = {nextElementSibling:null, after(node){this.nextElementSibling=node;}};
      return privacy;
    },
    changeTheme(theme){storageListener({theme:{newValue:theme}},'local');},
    nextWord(index,text='street'){wordIndex=index;target=text;input.value=' ';},
    async clickBadge(){badge.click();await settle();},
    replaceWord(){first=newWord();input.value=' ';},
    async clickRestart(){callbacks.click({target:{closest:()=>true}});await settle();},
  };
}
test('normal completion survives the interval where both panels are hidden',async()=>{
  const h=await harness();h.type('street');h.typing.shown=false;
  for(let i=0;i<20;i++) await h.changed();
  assert.equal(h.saves.length,0); assert.match(h.badge.textContent,/Ожидаю результаты/);
  h.result.shown=true;await h.changed();await h.changed();
  assert.equal(h.saves.length,1);assert.equal(h.saves[0].status,'completed');
});
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

test('completed comparison is visible on Monkeytype with both times and accuracy', async () => {
  const h = await harness(null,false,{completed:true,comparisons:[{language:'english',
    before:30,after:25,saved:5,beforeAccuracy:99,afterAccuracy:98}]});
  h.type('street');
  h.typing.shown=false;
  h.result.shown=true;
  await h.changed();
  const note=h.created.find(node=>node.id==='keyloom-daily-comparison');
  assert.equal(note.hidden,false);
  assert.match(note.textContent,/30.0 с → после 25.0 с/);
  assert.match(note.textContent,/99.0% → 98.0%/);
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
  const privacy = h.mountFooter();
  await h.changed();
  assert.equal(privacy.nextElementSibling, null);
  assert.equal(widget.open, undefined);
  h.type('st');
  assert.equal(widget.open, undefined);
  assert.equal(widget.inert, true);
  h.typing.shown = false;
  h.result.shown = true;
  await h.changed();
  assert.equal(widget.inert, false);
});
