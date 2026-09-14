(() => {
  const key = 'keyloom-fixture-v1';
  let index = 0;
  let finishTimer;
  let targets = ['street', 'strong', 'string', 'street', 'strong'];
  const input = document.getElementById('wordsInput');
  const words = document.getElementById('words');
  const initial = { sessions: [], settings: { enabled: true, layout: 'default' } };
  const storage = () => JSON.parse(localStorage.getItem(key) ?? JSON.stringify(initial));
  // Test transport only. Not distributed in the extension folder.
  globalThis.chrome = {
    runtime: { async sendMessage(message) {
      if (message.type === 'GET_STATE') return { ok: true, ...storage() };
      if (message.type === 'SAVE_SESSION') {
        const state = storage(); state.sessions = KeyloomCore.mergeSessions(state.sessions, [message.session]);
        localStorage.setItem(key, JSON.stringify(state));
        document.getElementById('saved').textContent = JSON.stringify(message.session, null, 2);
        return { ok: true, saved: true };
      }
      if (message.type === 'OPEN_DASHBOARD') { window.open('../extension/dashboard.html?fixture=1', '_blank'); return { ok: true }; }
    } },
    storage: { onChanged: { addListener() {} } },
  };
  function reset() {
    clearTimeout(finishTimer);
    index = 0; input.value = ' ';
    words.replaceChildren(...targets.map((text, i) => {
      const word = document.createElement('div'); word.className = 'word' + (i === 0 ? ' active' : ''); word.dataset.wordindex = String(i);
      for (const char of text) { const letter = document.createElement('letter'); letter.textContent = char; word.append(letter); }
      return word;
    }));
    document.getElementById('typingTest').classList.remove('hidden'); document.getElementById('result').classList.add('hidden');
    input.focus(); input.setSelectionRange(1,1);
  }
  function finish() {
    document.getElementById('typingTest').classList.add('hidden');
    // Reproduce Monkeytype's asynchronous typing -> results transition.
    finishTimer = setTimeout(() => document.getElementById('result').classList.remove('hidden'), 600);
  }
  input.addEventListener('beforeinput', event => {
    if (event.inputType === 'deleteContentBackward' && input.value.length <= 1) event.preventDefault();
    if (event.data === ' ' && input.value === ' ') event.preventDefault();
  });
  input.addEventListener('input', event => {
    if (event.data === ' ') {
      words.children[index]?.classList.remove('active'); index++;
      if (index >= targets.length) { finish(); return; }
      words.children[index].classList.add('active'); input.value = ' ';
    } else {
      const value = input.value.slice(1), word = words.children[index];
      if (!word) return;
      word.replaceChildren(...[...targets[index]].map((char, i) => {
        const letter = document.createElement('letter'); letter.textContent = char;
        if (i < value.length) letter.className = value[i] === char ? 'correct' : 'incorrect'; return letter;
      }));
    }
  });
  document.getElementById('restartTestButton').addEventListener('click', reset);
  document.getElementById('finish').addEventListener('click', finish);
  document.getElementById('unsupported').addEventListener('click', () => { targets = ['hello,', 'world']; reset(); });
  reset();
})();
