(() => {
  const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
  const day = timestamp => { const d=new Date(timestamp); return Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())/86400000; };
  function summary(sessions,{language='english',layout='default',days=30,mode='all',now=Date.now()}={}) {
    const all=sessions.filter(s=>s.language===language&&s.layout===layout).sort((a,b)=>a.date-b.date);
    const completed=all.filter(s=>s.status==='completed');
    const active=new Set(completed.map(s=>day(s.date)));
    const today=day(now);let cursor=active.has(today)?today:today-1,streak=0,best=0,run=0,prev=null;
    while(active.has(cursor)){streak++;cursor--;}
    for(const d of [...active].sort((a,b)=>a-b)){run=d===prev+1?run+1:1;best=Math.max(best,run);prev=d;}
    const selected=all.filter(s=>(days==='all'||s.date>=now-Number(days)*86400000)&&(mode==='all'||s.mode===mode));
    const valid=selected.filter(s=>s.status==='completed');
    const speeds=valid.filter(s=>s.duration>=5&&s.wpm>0).map(s=>s.wpm);
    const recent=mean(speeds.slice(-5)),before=speeds.length>=10?mean(speeds.slice(-10,-5)):null;
    const presses=valid.reduce((sum,s)=>sum+s.presses,0);
    const practiced=new Set();
    for(const s of completed) for(const target of s.training?.targets??[]) if(((s[s.training.kind === 'sequences' ? 'sequences' : 'pairs'] ?? {})[target]?.attempts??0)>0) practiced.add(target);
    return {all,selected,completed:valid,streak,best,activeDays:active.size,practiced:practiced.size,
      mean:mean(speeds),bestWpm:speeds.length?Math.max(...speeds):null,
      accuracy:presses?valid.reduce((sum,s)=>sum+s.accuracy*s.presses,0)/presses:null,
      bestAccuracy:valid.length?Math.max(...valid.map(s=>s.accuracy)):null,
      corrections:valid.reduce((sum,s)=>sum+s.corrections,0),presses,
      minutes:valid.reduce((sum,s)=>sum+s.duration,0)/60,
      growth:before&&recent!==null?{wpm:recent-before,percent:(recent/before-1)*100}:null,
      calendar:Array.from({length:56},(_,i)=>{const d=today-55+i;return {day:d,count:completed.filter(s=>day(s.date)===d).length};}),
    };
  }
  function plan(sessions,dictionary,{language='english',layout='default',seconds=60,kind='pairs',focus,manualTargets=[],ratio=.75,wordCount=null,extras={},random=Math.random}={}) {
    const symbolMode = ['uppercase', 'digits', 'punctuation'].includes(kind);
    const shared = ['digits', 'punctuation'].includes(kind);
    const profile=KeyloomCore.profile(sessions,{language,layout});
    const speedSessions = shared ? sessions.filter(s => s.layout === layout && s.status === 'completed') : profile.sessions;
    const speeds=speedSessions.filter(s=>s.duration>=5&&s.wpm>0).sort((a,b)=>a.date-b.date).slice(-20).map(s=>s.wpm);
    const wpm=mean(speeds)??40;
    const secondsSafe=[30,60,120,180,300].includes(Number(seconds))?Number(seconds):60;
    const p=kind==='mixed'?{pairs:[],words:[]}:kind==='words'?{...profile,pairs:[]}: {...profile,words:[]};
    const customTargets = focus ? [focus] : manualTargets;
    if (kind === 'sequences') p.pairs = profile.sequences;
    const alphabet = language === 'russian' ? /^[а-яё]+$/u : /^[a-z]+$/u;
    if (![.5, .75, 1].includes(ratio)) throw new Error('Недопустимая доля целевых слов.');
    if (!Array.isArray(customTargets) || customTargets.length > 12 || customTargets.some(target =>
      !KeyloomCore.validTarget(kind, target) || (!shared && !alphabet.test(target.toLowerCase())))) {
      throw new Error('Некорректные цели тренировки.');
    }
    const vocabulary = [...new Set([...dictionary, ...profile.words.map(row => row.key)])];
    if (customTargets.length && kind !== 'mixed') {
      p.pairs = [];
      p.words = [];
      p[kind] = customTargets.map(key => ({ key, reliable: true, score: 1 }));
      if (kind === 'pairs' || kind === 'sequences') {
        const missing = customTargets.filter(key => !vocabulary.some(word => word.includes(key)));
        if (missing.length) {
          throw new Error('В словаре нет слов с целями: ' + missing.join(', ') + '. Выбери другие цели или режим слов.');
        }
      }
    }
    let generated = KeyloomCore.generate(p, vocabulary, { count: 1000, random, ratio, targets: customTargets.length && (kind === 'pairs' || kind === 'sequences') ? customTargets : undefined });
    if (symbolMode) {
      const defaults = kind === 'uppercase'
        ? (language === 'russian' ? ['А', 'П', 'С', 'Т'] : ['A', 'S', 'T', 'R'])
        : kind === 'digits' ? [...'0123456789'] : [...'.,!?:;()-"'];
      const observed = profile[kind].filter(row => row.reliable && row.score > 0).slice(0, 12).map(row => row.key);
      const targets = customTargets.length ? customTargets : observed.length ? observed : defaults;
      generated = { targets, targeted: true, words: Array.from({ length: 1000 }, (_, index) => {
        const target = targets[index % targets.length];
        if (kind === 'digits') {
          return target + targets[(index + 3) % targets.length] + targets[(index + 7) % targets.length];
        }
        if (kind === 'punctuation') return String(index % 10) + target;
        const matching = vocabulary.filter(word => word.includes(target.toLowerCase()));
        const word = matching[Math.floor(random() * matching.length)] ?? target.toLowerCase();
        return word.replace(target.toLowerCase(), target);
      }) };
    }
    generated.words = generated.words.map((word, index) => {
      let token = word;
      if (extras.uppercase && kind !== 'uppercase' && index % 4 === 0) {
        token = token.replace(/[a-zа-яё]/u, letter => letter.toUpperCase());
      }
      if (extras.digits && kind !== 'digits' && index % 5 === 2) token += String(index % 100);
      if (extras.punctuation && kind !== 'punctuation' && index % 4 === 1) {
        token += ['.', ',', '!', '?'][Math.floor(index / 4) % 4];
      }
      return token;
    });
    const budget=wpm*5*secondsSafe/60;
    const words=[];let chars=0;
    for(const word of generated.words){
      const next=chars+(words.length?1:0)+[...word].length;
      if (wordCount !== null) {
        if (!Number.isInteger(wordCount) || wordCount < 10 || wordCount > 500) {
          throw new Error('Объём должен быть целым числом от 10 до 500 слов.');
        }
        if (words.length >= wordCount) break;
      } else if (words.length >= 10 && Math.abs(chars - budget) <= Math.abs(next - budget)) {
        break;
      }
      words.push(word);chars=next;
    }
    let targets = customTargets.length && (kind === 'pairs' || kind === 'sequences') ? customTargets : generated.targets;
    if(kind==='words') targets=p.words.filter(r=>r.reliable&&r.score>0).slice(0,12).map(r=>r.key);
    return {id:crypto.randomUUID(),date:Date.now(),language,layout,seconds:secondsSafe,kind,words,targets,
      ratio, wordCount, targeted:generated.targeted,estimatedSeconds:chars/(wpm*5)*60,wpm,calibrating:speeds.length===0,
      reason:symbolMode ? ({uppercase:'Заглавные буквы',digits:'Цифры',punctuation:'Знаки препинания'})[kind] : kind==='mixed'?'Обычная практика':generated.targeted?(kind==='words'?'Сложные слова':'Прицельная практика'):'Калибровка навыка'};
  }
  function validPlan(p){return !!p&&(p.wordCount == null || (Number.isInteger(p.wordCount) && p.wordCount >= 10 && p.wordCount <= 500 && p.wordCount === p.words?.length))&&/^[a-zA-Z0-9-]{1,100}$/.test(p.id)&&['english','russian'].includes(p.language)&&['default','alternate'].includes(p.layout)&&KeyloomCore.KINDS.includes(p.kind)&&[30,60,120,180,300].includes(p.seconds)&&Array.isArray(p.words)&&p.words.length>=10&&p.words.length<=1000&&p.words.every(KeyloomCore.supportedToken)&&Array.isArray(p.targets)&&p.targets.length<=12&&p.targets.every(t=>KeyloomCore.validTarget(p.kind,t));}
  function chartScale(values, metric = 'wpm') {
    const valid = values.filter(value => Number.isFinite(value) && value >= 0 &&
      (metric !== 'accuracy' || value <= 100));
    const low = valid.length ? Math.min(...valid) : 0;
    const high = valid.length ? Math.max(...valid) : 0;
    const padding = Math.max((high - low) * .1, metric === 'accuracy' ? .5 : 1);
    const start = Math.max(0, low - padding);
    const end = metric === 'accuracy' ? Math.min(100, high + padding) : high + padding;
    const rough = (end - start) / 4;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].find(value => value * magnitude >= rough) * magnitude;
    const min = Math.floor(start / step) * step;
    const max = metric === 'accuracy' ? Math.min(100, Math.ceil(end / step) * step) : Math.ceil(end / step) * step;
    const ticks = [];
    for (let value = min; value < max - step / 100; value += step) {
      ticks.push(Number(value.toFixed(6)));
    }
    ticks.push(Number(max.toFixed(6)));
    return { min, max, ticks };
  }
  globalThis.KeyloomAnalytics=Object.freeze({mean,day,summary,plan,validPlan,chartScale});
})();
