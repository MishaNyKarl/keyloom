(() => {
  function url(words, language, exerciseId) {
    if (!globalThis.LZString) throw new Error('Не загружен кодировщик упражнений');
    if (!words.length) throw new Error('Нет слов для тренировки');
    const settings = ['custom', null, { text: words, mode: 'repeat', limit: { mode: 'word', value: words.length }, pipeDelimiter: false }, false, false, language, 'normal', []];
    return 'https://monkeytype.com/?testSettings=' + LZString.compressToEncodedURIComponent(JSON.stringify(settings)) + (exerciseId ? '&keyloomExercise='+encodeURIComponent(exerciseId) : '');
  }
  globalThis.KeyloomPractice = { url };
})();
