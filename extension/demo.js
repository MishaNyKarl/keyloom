(() => {
  function sessions() {
    const result = [];
    for (const language of ['english', 'russian']) {
      for (let day = 0; day < 12; day++) {
        const targets = language === 'english' ? ['street','strong','start','think','other','there','letter','little','three','story','time','world'] : ['строка','остров','быстро','страна','просто','встреча','слово','точность','мысль','работа','время','город'];
        const events = [];
        let time = 0;
        for (let repeat = 0; repeat < 3; repeat++) {
          targets.forEach((target, index) => {
            [...target].forEach((typed, position) => {
              const fail = position === 2 && (index + day + repeat) % 5 === 0;
              time += 105 + (12 - day) * 4 + (position === 2 ? 125 : 0) + (index % 4) * 15;
              const base = { target, position, wordIndex: repeat * targets.length + index };
              events.push({ ...base, type: 'insert', typed: fail ? 'x' : typed, time });
              if (fail) {
                events.push({ ...base, type: 'delete', time: time += 180 });
                events.push({ ...base, type: 'insert', typed, time: time += 130 });
              }
            });
            events.push({ target, position: target.length, wordIndex: repeat * targets.length + index, type: 'insert', typed: ' ', time: time += 110 });
          });
        }
        result.push(KeyloomCore.analyze(events, { id: `demo-${language}-${day}`, date: Date.now() - (11 - day) * 86400000,
          language, layout: 'default', status: 'completed', mode: day>=9?'custom':'words', source: 'demo',
          ...(day>=9?{training:{id:`exercise-${language}-${day}`,kind:'pairs',seconds:60,targets:language==='english'?['st','th']:['ст','ро']}}:{}) }));
      }
    }
    return result;
  }
  globalThis.KeyloomDemo = { sessions };
})();
