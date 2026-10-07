/* Read only the configuration controls, never infer a mode from arbitrary tag text. */
(() => {
  const label = text => String(text ?? '').replace(/[\uE000-\uF8FF\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  function selected(button) {
    const pressed = button.getAttribute('aria-pressed');
    if (pressed === 'true' || pressed === 'false') return pressed === 'true';
    return button.classList.contains('active') || button.classList.contains('[--themable-button-text:var(--themable-button-active)]');
  }
  const modifiers = [
    ['fa-gamepad', 'Отключите funbox'],
    ['fa-hand-paper', 'Отключите stop on error'],
    ['fa-eraser', 'Отключите delete on error'],
    ['fa-keyboard', 'Отключите эмуляцию раскладки'],
    ['fa-couch', 'Отключите lazy mode'],
    ['fa-eye-slash', 'Отключите blind mode'],
    ['fa-star-half-alt', 'Выберите difficulty: normal'],
    ['fa-star', 'Выберите difficulty: normal'],
    ['fa-bomb', 'Отключите минимальные пороги теста'],
    ['fa-backspace', 'Отключите confidence mode'],
    ['fa-exchange-alt', 'Отключите opposite shift'],
  ];
  function inspect({ notices = [], buttons = [] }) {
    for (const item of notices) {
      const icons = item.icons ?? [];
      // Language is identified by its control icon, not by being the only notice.
      if (icons.includes('fa-globe-americas')) {
        const name = label(item.text);
        if (!/^(english|russian)(?:[ _]|$)/i.test(name)) return { ok: false, reason: `Язык не поддерживается: ${name || 'не определён'}` };
      }
      for (const [icon, reason] of modifiers) {
        if (icons.includes(icon)) return { ok: false, reason };
      }
      // Tags, PB/average indicators, pace caret and saving notices are informational.
      // Unknown notice text is not evidence of an unsupported modifier.
    }
    const languageNotice = notices.find(item => item.icons?.includes('fa-globe-americas'));
    const language = languageNotice ? label(languageNotice.text).match(/^(english|russian)/)?.[1] : undefined;
    const timeMode = buttons.some(button => button.selected && label(button.text) === 'time');
    const duration = timeMode ? buttons.find(button => button.selected && /^\d+$/.test(label(button.text))) : null;
    const configuredWordset = languageNotice ? label(languageNotice.text).replace(/ /g, '_') : undefined;
    return { ok: true, language, configuredWordset,
      ...(duration ? {configuredSeconds:Number(label(duration.text))} : {}) };
  }
  function read(doc) {
    const root = doc.querySelector('mount[data-component="testmodesnotice"]');
    const notices = Array.from(root?.querySelectorAll('button') ?? []).map(button => ({
      text: button.textContent,
      icons: Array.from(button.querySelectorAll('[class]')).flatMap(icon => Array.from(icon.classList)).filter(c => c.startsWith('fa-')),
    }));
    const buttons = Array.from(doc.querySelectorAll('[data-ui-element="testConfig"] button, #testConfig button')).map(button => ({ text: button.textContent, selected: selected(button) }));
    return inspect({ notices, buttons });
  }
  async function prepare(doc, settings) {
    const current = read(doc);
    const [mode, duration, custom, punctuation, numbers, wordset] = settings;
    // Use the site's UI only; never touch account state or private page modules.
    if (!current.ok || current.configuredWordset !== wordset ||
      !['time', 'custom'].includes(mode)) {
      return null;
    }
    const buttons = Array.from(doc.querySelectorAll(
      '[data-ui-element="testConfig"] button, #testConfig button'));
    const find = text => buttons.find(button => label(button.textContent) === text);
    if (['punctuation', 'numbers'].some((name, index) =>
      !find(name) || selected(find(name)) !== [punctuation, numbers][index])) {
      return null;
    }
    const modeButton = find(mode);
    if (!modeButton) {
      return null;
    }
    if (mode === 'time') {
      const timeButton = find(String(duration));
      const next = doc.querySelector('#nextTestButton');
      if (!timeButton || !next) {
        return null;
      }
      return () => {
        if (!selected(modeButton)) {
          modeButton.click();
        }
        if (!selected(timeButton)) {
          timeButton.click();
        } else {
          next.click();
        }
      };
    }
    if (!custom || custom.mode !== 'repeat' || custom.pipeDelimiter ||
      custom.limit?.mode !== 'word' || custom.limit.value !== custom.text.length) {
      return null;
    }
    if (!selected(modeButton)) {
      modeButton.click();
    }
    const change = find('change');
    if (!change) {
      return null;
    }
    change.click();
    for (let attempt = 0; attempt < 30; attempt++) {
      const modal = doc.querySelector('#CustomTextModal, #customTextPopup');
      const text = modal?.querySelector('textarea');
      const simple = Array.from(modal?.querySelectorAll('button') ?? [])
        .find(button => label(button.textContent) === 'simple');
      const space = Array.from(modal?.querySelectorAll('button') ?? [])
        .find(button => label(button.textContent) === 'space');
      const submit = modal?.querySelector('button[type="submit"]');
      if (text && simple && space && submit && !text.disabled && !submit.disabled) {
        simple.click();
        space.click();
        text.value = custom.text.join(' ');
        text.dispatchEvent(new Event('input', {bubbles:true}));
        return () => submit.click();
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return null;
  }
  globalThis.KeyloomConfiguration = Object.freeze({ inspect, read, selected, label, prepare });
})();
