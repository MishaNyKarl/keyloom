(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const root = document.documentElement;
  const valid = value => ['dark', 'light', 'repose-dark'].includes(value) ? value : 'dark';
  const preview = new URLSearchParams(location.search).get('demo') === '1' || !api?.runtime?.id;
  const choices = Array.from(document.querySelectorAll('input[name="keyloom-theme"]'));
  const apply = value => {
    root.setAttribute('data-keyloom-theme', valid(value));
    for (const choice of choices) choice.checked = choice.value === valid(value);
  };
  const report = error => {
    const output = document.getElementById('theme-error');
    if (output) output.textContent = 'Не удалось сохранить тему: ' + error.message;
  };
  apply('dark');
  let revision = 0;
  const initialRevision = revision;
  if (preview) {
    try { apply(localStorage.getItem('keyloom-theme')); } catch (error) { report(error); }
  } else {
    api.storage.local.get('theme').then(state => {
      if (revision === initialRevision) apply(state.theme);
    }).catch(report);
    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.theme) { revision++; apply(changes.theme.newValue); }
    });
  }
  for (const choice of choices) choice.addEventListener('change', async event => {
    if (!event.target.checked) return;
    const theme = valid(event.target.value);
    const previous = root.getAttribute('data-keyloom-theme');
    revision++;
    apply(theme);
    try {
      if (preview) localStorage.setItem('keyloom-theme', theme);
      else await api.storage.local.set({theme});
      document.getElementById('theme-error').textContent = '';
    } catch (error) { apply(previous); report(error); }
  });
})();
