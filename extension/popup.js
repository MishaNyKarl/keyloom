const status = document.getElementById('status');
const toggle = document.getElementById('enabled');
let settings;
async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error ?? 'Не удалось загрузить данные');
  return reply;
}
send({ type: 'GET_STATE' }).then(state => {
  settings = state.settings; toggle.checked = settings.enabled;
  document.getElementById('count').textContent = state.sessions.filter(s => s.status === 'completed').length;
}).catch(error => { status.textContent = error.message; toggle.disabled = true; });
toggle.addEventListener('change', async () => {
  try {
    settings = { ...settings, enabled: toggle.checked };
    await send({ type: 'SET_SETTINGS', settings });
    status.textContent = settings.enabled ? 'Начни новый тест Monkeytype.' : 'Запись на паузе.';
  } catch (error) { status.textContent = error.message; }
});
document.getElementById('open').addEventListener('click', () => send({ type: 'OPEN_DASHBOARD' }).then(() => window.close()).catch(error => status.textContent = error.message));
