import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/configuration.js';
const { inspect, read, selected } = KeyloomConfiguration;
const notice = (text, icon) => ({ text, icons: [icon] });
test('language with informational notices is accepted (regression for ordinary RU/EN tests)', () => {
  for (const text of ['english','english 1k','russian','russian 10k','russian_1k','\uf57d russian\u00a010k']) {
    const result = inspect({ notices: [notice(text,'fa-globe-americas'),notice('my practice','fa-tags'),notice('pb pace 60 wpm','fa-tachometer-alt'),notice('saving disabled','fa-save'),notice('average 70 wpm','fa-chart-line')] });
    assert.equal(result.ok,true,text);
  }
});
test('tag names cannot masquerade as languages or modifiers', () => {
  assert.equal(inspect({notices:[notice('english','fa-globe-americas'),notice('stop on word','fa-tag'),notice('french','fa-tag')]}).ok,true);
  assert.match(inspect({notices:[notice('french','fa-globe-americas')]}).reason,/Язык не поддерживается/);
});
test('actual unsupported modifiers return specific instructions', () => {
  for (const [icon, expected] of [['fa-gamepad','funbox'],['fa-hand-paper','stop on error'],['fa-eraser','delete on error'],['fa-keyboard','эмуляцию'],['fa-eye-slash','blind']]) {
    const result = inspect({notices:[notice('english','fa-globe-americas'),notice('setting',icon)]});
    assert.equal(result.ok,false); assert.ok(result.reason.includes(expected));
  }
});
test('punctuation and numbers toggles are accepted in supported tests', () => {
  assert.equal(inspect({buttons:[{text:'punctuation',selected:false},{text:'numbers',selected:false}]}).ok,true);
  assert.equal(inspect({buttons:[{text:'numbers',selected:true}]}).ok,true);
  assert.equal(inspect({buttons:[{text:'\uf1fa punctuation',selected:true}]}).ok,true);
});
function button(text, classes = [], icons = [], pressed = null) {
  return {textContent:text,classList:{contains:value=>classes.includes(value)},getAttribute:()=>pressed,
    querySelectorAll:()=>icons.map(icon=>({classList:new Set(['fas',icon])}))};
}
test('read adapter identifies notices from their icons and honors ARIA toggle state', () => {
  const doc = { querySelector:()=>({querySelectorAll:()=>[button('russian',[],['fa-globe-americas']),button('morning',[],['fa-tags'])]}),
    querySelectorAll:()=>[button('numbers',['[--themable-button-active:var(--main-color)]'])] };
  assert.equal(read(doc).ok,true);
  assert.equal(selected(button('numbers',['active'],[],'false')),false);
  assert.equal(selected(button('words',[],[],'true')),true);
  assert.equal(selected(button('words',['[--themable-button-text:var(--themable-button-active)]'])),true);
});

test('captures selected time duration without confusing words mode', () => {
  const timed = KeyloomConfiguration.inspect({buttons:[{text:'time',selected:true},{text:'60',selected:true}]});
  assert.equal(timed.configuredSeconds,60);
  const words = KeyloomConfiguration.inspect({buttons:[{text:'words',selected:true},{text:'60',selected:true}]});
  assert.equal(words.configuredSeconds,undefined);
});

function launchDocument(mode = 'time', wordset = 'english') {
  const clicks = [];
  const controls = ['time', 'custom', '15', '30', '60', '120', 'change', 'punctuation', 'numbers']
    .map(text => ({textContent:text, getAttribute:() => String(text === mode || text === '60'),
      click:() => clicks.push(text)}));
  const next = {click:() => clicks.push('next')};
  const doc = {
    querySelector:selector => selector.includes('testmodesnotice') ?
      {querySelectorAll:() => [button(wordset, [], ['fa-globe-americas'])]} :
      (selector === '#nextTestButton' ? next : null),
    querySelectorAll:() => controls
  };
  return {doc, clicks};
}

test('in-place time launch restarts same duration and changes a different duration via controls', async () => {
  const h = launchDocument();
  const start = await KeyloomConfiguration.prepare(h.doc,
    ['time', '60', null, false, false, 'english']);
  assert.deepEqual(h.clicks, []);
  start();
  assert.deepEqual(h.clicks, ['next']);
  const change = await KeyloomConfiguration.prepare(h.doc,
    ['time', '30', null, false, false, 'english']);
  change();
  assert.deepEqual(h.clicks, ['next', '30']);
});

test('unsupported in-place settings fall back before touching controls', async () => {
  const h = launchDocument();
  for (const settings of [
    ['time', '60', null, false, false, 'russian'],
    ['time', '60', null, false, false, 'english_5k'],
    ['quote', '719', null, false, false, 'english'],
    ['time', '60', null, true, false, 'english'],
    ['time', '300', null, false, false, 'english']
  ]) {
    assert.equal(await KeyloomConfiguration.prepare(h.doc, settings), null);
  }
  assert.deepEqual(h.clicks, []);
});

test('custom launch fills only the custom modal and submits an exact simple word test', async () => {
  const h = launchDocument('custom');
  const text = {value:'old', dispatchEvent:event => h.clicks.push(event.type)};
  const modal = {
    querySelector:selector => selector === 'textarea' ? text : {click:() => h.clicks.push('submit')},
    querySelectorAll:() => ['simple', 'space'].map(textContent =>
      ({textContent, click:() => h.clicks.push(textContent)}))
  };
  const query = h.doc.querySelector;
  h.doc.querySelector = selector => selector.includes('CustomTextModal') ? modal : query(selector);
  const start = await KeyloomConfiguration.prepare(h.doc,
    ['custom', null, {text:['hello', 'world'], mode:'repeat',
      limit:{mode:'word', value:2}, pipeDelimiter:false}, false, false, 'english']);
  assert.equal(text.value, 'hello world');
  assert.deepEqual(h.clicks, ['change', 'simple', 'space', 'input']);
  start();
  assert.equal(h.clicks.at(-1), 'submit');
});
