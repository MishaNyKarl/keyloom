import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../extension/theme.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
async function harness(namespace = 'chrome', initial = 'light', preview = false) {
  const attributes = {};
  const choices = ['dark', 'light', 'repose-dark', 'lime', 'honey', 'dualshot', 'trackday'].map(value => ({value,
    addEventListener(event, callback) { this[event] = callback; }}));
  const select = {get value() { return choices.find(choice => choice.checked)?.value; },
    async change(event) {
      const choice = choices.find(row => row.value === event.target.value);
      choice.checked = true;
      await choice.change({target:choice});
    }};
  const error = {};
  const saved = {theme:initial, settings:{enabled:true, layout:'default'}};
  let listener;
  const api = {runtime:{id:'test'}, storage:{
    local:{get:async () => ({theme:saved.theme}), set:async value => Object.assign(saved,value)},
    onChanged:{addListener(callback) { listener = callback; }}
  }};
  const context = vm.createContext({URLSearchParams, location:{search:preview ? '?demo=1' : ''},
    document:{documentElement:{setAttribute:(key,value) => attributes[key] = value,
      getAttribute:key => attributes[key]}, querySelectorAll:() => choices, getElementById:() => error},
    [namespace]:api,
    localStorage:{getItem:() => initial, setItem:(key,value) => saved.preview = value}
  });
  vm.runInContext(source,context);
  await settle();
  return {attributes,select,choices,error,saved,api,change:theme => listener({theme:{newValue:theme}},'local')};
}

for (const namespace of ['chrome','browser']) {
  test('themes persist without modifying capture settings: ' + namespace, async () => {
    const h = await harness(namespace);
    assert.equal(h.select.value,'light');
    await h.select.change({target:{value:'repose-dark'}});
    assert.equal(h.saved.theme,'repose-dark');
    assert.equal(h.choices.filter(choice => choice.checked).length,1);
    assert.equal(h.attributes['data-keyloom-theme'],'repose-dark');
    assert.deepEqual(h.saved.settings,{enabled:true,layout:'default'});
    h.change('dark');
    assert.equal(h.select.value,'dark');
    h.change('unknown');
    assert.equal(h.select.value,'dark');
    const reopened = await harness(namespace,h.saved.theme);
    assert.equal(reopened.select.value,'repose-dark');
  });
}
test('preview themes stay separate and storage errors remain visible', async () => {
  const preview = await harness('chrome','dark',true);
  await preview.select.change({target:{value:'light'}});
  assert.equal(preview.saved.preview,'light');
  assert.equal(preview.saved.theme,'dark');
  const h = await harness();
  h.api.storage.local.set = async () => { throw new Error('Storage unavailable'); };
  await h.select.change({target:{value:'repose-dark'}});
  assert.match(h.error.textContent,/Storage unavailable/);
  assert.equal(h.select.value,'light');
});

test('fonts are local WOFF2 assets and content resources are limited to Monkeytype', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
  assert.deepEqual(manifest.web_accessible_resources,
    [{resources:['fonts/*.woff2','icons/lucide/*.svg'],matches:['https://monkeytype.com/*']}]);
  for (const name of ['Regular','Bold']) {
    const font = await readFile(new URL('../extension/fonts/JetBrainsMono-' + name + '.woff2', import.meta.url));
    assert.equal(font.toString('ascii',0,4),'wOF2');
  }
  const license = await readFile(new URL('../extension/fonts/OFL.txt', import.meta.url),'utf8');
  assert.match(license,/SIL OPEN FONT LICENSE/);
});

for (const theme of ['lime', 'honey', 'dualshot', 'trackday']) {
  test('additional theme persists and restores: ' + theme, async () => {
    const h = await harness();
    await h.select.change({target:{value:theme}});
    assert.equal(h.saved.theme, theme);
    assert.equal(h.attributes['data-keyloom-theme'], theme);
    const reopened = await harness('browser', h.saved.theme);
    assert.equal(reopened.select.value, theme);
    assert.equal(reopened.choices.filter(choice => choice.checked).length, 1);
  });
}
