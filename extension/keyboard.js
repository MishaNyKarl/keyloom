(() => {
  function create({commands, canOpen = () => true, theme, escape = false, hidePointer = false}) {
    let dialog, input, list, error, previousFocus, busy = false, pointerTimer;
    const ready = () => canOpen() && !document.querySelector('dialog[open]:not(#keyloom-command-menu)');
    const available = () => commands.filter(command => !command.available || command.available());
    const stop = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    function render() {
      const query = input.value.trim().toLowerCase();
      const matches = available().filter(command =>
        (command.label + ' ' + (command.alias ?? '')).toLowerCase().includes(query));
      list.replaceChildren();
      for (const command of matches) {
        const button = document.createElement('button');
        button.type = 'button';
        const label = document.createElement('span');
        label.className = 'keyloom-command-label';
        label.textContent = command.label;
        button.append(label);
        if (command.key) {
          const hint = document.createElement('kbd');
          hint.textContent = 'Alt+' + command.key.slice(3);
          button.append(hint);
        }
        button.addEventListener('click', () => void run(command));
        list.append(button);
      }
      if (!matches.length) {
        const empty = document.createElement('p');
        empty.textContent = 'Команды не найдены';
        list.append(empty);
      }
      return matches;
    }
    async function run(command) {
      if (busy || !ready() || (command.available && !command.available())) return;
      busy = true;
      try {
        dialog?.close();
        await command.run();
      } catch (cause) {
        open();
        error.textContent = cause.message ?? 'Не удалось выполнить команду';
      } finally { busy = false; }
    }
    function open() {
      if (!ready()) return;
      if (!dialog) {
        dialog = document.createElement('dialog');
        dialog.id = 'keyloom-command-menu';
        dialog.setAttribute('aria-label', 'Команды Keyloom');
        const heading = document.createElement('div');
        heading.className = 'keyloom-command-search';
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'esc';
        close.setAttribute('aria-label', 'Закрыть меню команд');
        close.addEventListener('click', () => dialog.close());
        input = document.createElement('input');
        input.type = 'search';
        input.placeholder = 'Найти команду…';
        input.setAttribute('aria-label', 'Найти команду Keyloom');
        heading.append(input, close);
        list = document.createElement('div');
        list.className = 'keyloom-command-list';
        error = document.createElement('p');
        error.setAttribute('role', 'alert');
        dialog.append(heading, list, error);
        document.body.append(dialog);
        input.addEventListener('input', render);
        dialog.addEventListener('close', () => previousFocus?.focus());
        // Keep editable input and native button behavior, but do not let the
        // host's global typing handlers consume menu events or steal focus.
        for (const type of ['keypress', 'keyup', 'beforeinput', 'input', 'click']) {
          dialog.addEventListener(type, event => event.stopPropagation());
        }
        dialog.addEventListener('keydown', event => {
          event.stopPropagation();
          if (event.isComposing) return;
          const buttons = Array.from(list.querySelectorAll('button'));
          const index = buttons.indexOf(document.activeElement);
          if (['ArrowDown','ArrowUp'].includes(event.key) && buttons.length) {
            stop(event);
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            const next = index < 0 ? (direction > 0 ? 0 : buttons.length - 1)
              : (index + direction + buttons.length) % buttons.length;
            buttons[next].focus();
          } else if (event.key === 'Enter' && document.activeElement === input) {
            stop(event);
            const command = render()[0];
            if (command) void run(command);
          } else if (event.key === 'Escape') {
            stop(event);
            dialog.close();
          }
        });
      }
      dialog.setAttribute('data-keyloom-theme', theme?.() ?? document.documentElement.getAttribute('data-keyloom-theme') ?? 'dark');
      if (!dialog.open) {
        previousFocus = document.activeElement;
        dialog.showModal();
      }
      input.value = '';
      error.textContent = '';
      render();
      input.focus();
    }
    document.addEventListener('keydown', event => {
      if (!event.isTrusted || event.repeat || event.isComposing || !ready()) return;
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (event.code === 'KeyK') { stop(event); open(); return; }
        const command = available().find(row => row.key === event.code);
        if (command) { stop(event); void run(command); }
      } else if (escape && event.key === 'Escape' && !dialog?.open &&
        !document.querySelector('dialog[open]') &&
        !event.target.closest?.('input, textarea, select, [contenteditable="true"]')) {
        stop(event);
        open();
      }
    }, true);
    if (hidePointer) {
      const wake = () => {
        clearTimeout(pointerTimer);
        document.documentElement.classList.remove('keyloom-pointer-idle');
        pointerTimer = setTimeout(() => document.documentElement.classList.add('keyloom-pointer-idle'), 2500);
      };
      document.addEventListener('pointermove', wake, {passive:true});
      document.addEventListener('keydown', wake);
      document.addEventListener('visibilitychange', () => {
        clearTimeout(pointerTimer);
        document.documentElement.classList.remove('keyloom-pointer-idle');
      });
    }
    return {open};
  }
  globalThis.KeyloomKeyboard = Object.freeze({create});
})();
