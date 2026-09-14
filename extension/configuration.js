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
    for (const button of buttons) {
      if (!button.selected) continue;
      const text = label(button.text);
      if (text === 'punctuation') return { ok: false, reason: 'Отключите punctuation' };
      if (text === 'numbers') return { ok: false, reason: 'Отключите numbers' };
    }
    return { ok: true };
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
  globalThis.KeyloomConfiguration = Object.freeze({ inspect, read, selected, label });
})();
