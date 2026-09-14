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
test('disabled punctuation/numbers are allowed; active controls name the blocker', () => {
  assert.equal(inspect({buttons:[{text:'punctuation',selected:false},{text:'numbers',selected:false}]}).ok,true);
  assert.equal(inspect({buttons:[{text:'numbers',selected:true}]}).reason,'Отключите numbers');
  assert.equal(inspect({buttons:[{text:'\uf1fa punctuation',selected:true}]}).reason,'Отключите punctuation');
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
