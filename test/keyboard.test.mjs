import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../extension/keyboard.js',import.meta.url),'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const handlers = {}, nodes = [], timers = new Map();
  let clock = 0;
  const doc = {activeElement:null,
    addEventListener(type, fn) { (handlers[type] ??= []).push(fn); },
    querySelector:() => null
  };
  function node(tag) {
    const value = {tag,children:[],attributes:{},value:'',open:false,listeners:{},
      setAttribute(key,text) { this.attributes[key]=text; },
      getAttribute(key) { return this.attributes[key] ?? null; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children=children; },
      addEventListener(type,fn) { this.listeners[type]=fn; },
      querySelectorAll(type) { return this.children.filter(child=>child.tag===type); },
      focus() { doc.activeElement=this; },
      showModal() { this.open=true; },
      close() { this.open=false; this.listeners.close?.(); },
      closest() { return null; }
    };
    nodes.push(value);
    return value;
  }
  const classes = new Set();
  doc.documentElement = node('html');
  doc.documentElement.classList = {add:key=>classes.add(key),remove:key=>classes.delete(key)};
  doc.body=node('body');doc.createElement=node;
  const origin=node('button');origin.focus();
  const context=vm.createContext({document:doc,
    setTimeout:fn=>{timers.set(++clock,fn);return clock;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(source,context);
  const menu=context.KeyloomKeyboard.create(options);
  const event=(changes={})=>({isTrusted:true,code:'',key:'',target:doc.activeElement,
    preventDefault(){this.prevented=true;},stopPropagation(){this.propagationStopped=true;},stopImmediatePropagation(){this.stopped=true;},...changes});
  const key=async changes=>{const e=event(changes);for(const fn of handlers.keydown??[])fn(e);await settle();return e;};
  return {doc,nodes,menu,key,event,origin,handlers,classes,timers};
}

test('shortcuts preserve Tab, Escape, text input, IME and repeated keys on Monkeytype',async()=>{
  let count=0,active=false;
  const h=harness({canOpen:()=>!active,commands:[{label:'Next',key:'KeyN',run:()=>count++}]});
  for(const change of [{key:'Tab'},{key:'Escape'},{code:'KeyN'},
    {altKey:true,code:'KeyN',repeat:true},{altKey:true,code:'KeyN',isComposing:true},
    {altKey:true,code:'KeyN',isTrusted:false}]) {
    assert.equal((await h.key(change)).prevented,undefined);
  }
  active=true;
  assert.equal((await h.key({altKey:true,code:'KeyN'})).prevented,undefined);
  active=false;
  assert.equal((await h.key({altKey:true,code:'KeyN',key:'т'})).prevented,true);
  assert.equal(count,1);
});

test('command search, arrows, Enter and Escape work and restore focus',async()=>{
  let count=0;
  const h=harness({commands:[{label:'Daily plan',alias:'ежедневный',run:()=>count++},
    {label:'Unavailable',available:()=>false,run:()=>assert.fail()}]});
  await h.key({altKey:true,code:'KeyK'});
  const dialog=h.nodes.find(node=>node.tag==='dialog');
  const input=h.nodes.find(node=>node.tag==='input');
  const list=h.nodes.find(node=>node.className==='keyloom-command-list');
  assert.equal(dialog.open,true);
  assert.equal(list.children.length,1);
  input.value='missing';input.listeners.input();
  assert.equal(list.children[0].textContent,'Команды не найдены');
  input.value='ежедневный';input.listeners.input();
  dialog.listeners.keydown(h.event({key:'ArrowDown'}));
  assert.equal(h.doc.activeElement,list.children[0]);
  input.focus();
  dialog.listeners.keydown(h.event({key:'Enter'}));
  await settle();
  assert.equal(count,1);
  assert.equal(dialog.open,false);
  assert.equal(h.doc.activeElement,h.origin);
  h.menu.open();dialog.listeners.keydown(h.event({key:'Escape'}));
  assert.equal(dialog.open,false);
});

test('unavailable and pending commands cannot run twice; failures remain visible',async()=>{
  let resolve,count=0,available=false;
  const h=harness({commands:[{label:'Next',key:'KeyN',available:()=>available,
    run:()=>{count++;return new Promise(done=>resolve=done);}}]});
  assert.equal((await h.key({altKey:true,code:'KeyN'})).prevented,undefined);
  available=true;
  await h.key({altKey:true,code:'KeyN'});await h.key({altKey:true,code:'KeyN'});
  assert.equal(count,1);resolve();await settle();
  const failed=harness({commands:[{label:'Fail',key:'KeyN',run:()=>{throw new Error('offline');}}]});
  await failed.key({altKey:true,code:'KeyN'});
  assert.equal(failed.nodes.find(node=>node.attributes.role==='alert').textContent,'offline');
});

test('dashboard cursor hides after inactivity and movement restores it',()=>{
  const h=harness({commands:[],hidePointer:true});
  h.handlers.pointermove[0]();
  Array.from(h.timers.values())[0]();
  assert.equal(h.classes.has('keyloom-pointer-idle'),true);
  h.handlers.pointermove[0]();
  assert.equal(h.classes.has('keyloom-pointer-idle'),false);
  h.handlers.visibilitychange[0]();
  assert.equal(h.timers.size,0);
});

test('palette text input stays editable without leaking events to host shortcuts', async () => {
  const h = harness({commands:[{label:'Ежедневный план', run:() => {}}]});
  h.menu.open();
  const dialog = h.nodes.find(node => node.tag === 'dialog');
  const input = h.nodes.find(node => node.tag === 'input');
  for (const change of [{key:'д'}, {key:'Backspace'}, {key:'v',ctrlKey:true},
    {key:'Process',isComposing:true}]) {
    const event = h.event(change);
    dialog.listeners.keydown(event);
    // Simulate the host's global handler consuming keys or moving focus.
    if (!event.propagationStopped && !event.stopped) {
      event.preventDefault();
      h.origin.focus();
    }
    assert.equal(event.prevented, undefined);
    assert.equal(h.doc.activeElement, input);
  }
  input.value = 'ежедневный';
  input.listeners.input();
  const list = h.nodes.find(node => node.className === 'keyloom-command-list');
  assert.equal(list.children.length, 1);
  for (const type of ['keypress', 'keyup', 'beforeinput', 'input', 'click']) {
    const event = h.event();
    dialog.listeners[type](event);
    assert.equal(event.propagationStopped, true);
    assert.equal(event.prevented, undefined);
  }
});

test('command numbers remain stable during search and Enter runs an exact number', async () => {
  const calls = [];
  const h = harness({commands:Array.from({length:12}, (_, index) => ({
    label:'Command ' + (index + 1), run:() => calls.push(index + 1)
  }))});
  h.menu.open();
  const input = h.nodes.find(node => node.tag === 'input');
  const dialog = h.nodes.find(node => node.tag === 'dialog');
  const list = h.nodes.find(node => node.className === 'keyloom-command-list');
  input.value = 'Command 12';
  input.listeners.input();
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[0].textContent, '12');
  for (const query of ['0', '13', '999999999999999999999']) {
    input.value = query;
    input.listeners.input();
    assert.equal(list.children[0].textContent, 'Команды не найдены');
    dialog.listeners.keydown(h.event({key:'Enter'}));
    assert.equal(calls.length, 0);
  }
  input.value = ' 2 ';
  input.listeners.input();
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[0].textContent, '2');
  dialog.listeners.keydown(h.event({key:'Enter'}));
  await settle();
  assert.deepEqual(calls, [2]);
  assert.equal(dialog.open, false);
  h.menu.open();
  input.value = '12';
  dialog.listeners.keydown(h.event({key:'Enter'}));
  await settle();
  assert.deepEqual(calls, [2, 12]);
});
