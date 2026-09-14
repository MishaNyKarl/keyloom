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
    for(const s of completed) for(const target of s.training?.targets??[]) if((s.pairs[target]?.attempts??0)>0) practiced.add(target);
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
  function plan(sessions,dictionary,{language='english',layout='default',seconds=60,kind='pairs',focus,random=Math.random}={}) {
    const profile=KeyloomCore.profile(sessions,{language,layout});
    const speeds=profile.sessions.filter(s=>s.duration>=5&&s.wpm>0).sort((a,b)=>a.date-b.date).slice(-20).map(s=>s.wpm);
    const wpm=mean(speeds)??40;
    const secondsSafe=[30,60,120,180,300].includes(Number(seconds))?Number(seconds):60;
    const p=kind==='mixed'?{pairs:[],words:[]}:kind==='words'?{...profile,pairs:[]}: {...profile,words:[]};
    const generated=KeyloomCore.generate(p,dictionary,{count:1000,focus,random});
    const budget=wpm*5*secondsSafe/60;
    const words=[];let chars=0;
    for(const word of generated.words){
      const next=chars+(words.length?1:0)+[...word].length;
      if(words.length>=10&&Math.abs(chars-budget)<=Math.abs(next-budget))break;
      words.push(word);chars=next;
    }
    let targets=generated.targets;
    if(kind==='words'&&!focus) targets=profile.words.filter(r=>r.reliable&&r.score>0).slice(0,12).map(r=>r.key);
    return {id:crypto.randomUUID(),date:Date.now(),language,layout,seconds:secondsSafe,kind,words,targets,
      targeted:generated.targeted,estimatedSeconds:chars/(wpm*5)*60,wpm,calibrating:speeds.length===0,
      reason:kind==='mixed'?'Обычная практика':generated.targeted?(kind==='words'?'Сложные слова':'Прицельная практика'):'Калибровка навыка'};
  }
  function validPlan(p){return !!p&&/^[a-zA-Z0-9-]{1,100}$/.test(p.id)&&['english','russian'].includes(p.language)&&['default','alternate'].includes(p.layout)&&['pairs','words','mixed'].includes(p.kind)&&[30,60,120,180,300].includes(p.seconds)&&Array.isArray(p.words)&&p.words.length>=10&&p.words.length<=1000&&p.words.every(w=>typeof w==='string'&&/^[a-zа-яё]{1,100}$/iu.test(w))&&Array.isArray(p.targets)&&p.targets.length<=12&&p.targets.every(t=>typeof t==='string'&&/^[a-zа-яё]{1,100}$/iu.test(t));}
  globalThis.KeyloomAnalytics=Object.freeze({mean,day,summary,plan,validPlan});
})();
