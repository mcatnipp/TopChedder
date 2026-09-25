/* TopCheddar.AI — game board. Data: data/<date>.json (Claude pipeline), live odds: /.netlify/functions/odds */
const $=s=>document.querySelector(s);
const pct=x=>x==null?'—':Math.round(x*100)+'%';
const sgn=x=>x==null?'—':(x>0?'+':'')+x.toFixed(1);
const odds=o=>o==null?'—':(o>0?'+'+o:String(o));
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const imp=o=>o==null?null:(o<0?-o/(-o+100):100/(o+100));
const dec=o=>o>0?1+o/100:1+100/-o;
const evOf=(p,o)=>p==null||o==null?null:p*(dec(o)-1)-(1-p);
const LOGO={NJD:'nj',TBL:'tb',LAK:'la',SJS:'sj',UTA:'utah',VGK:'vgk',WSH:'wsh'};
const logo=(ab,cls='team-logo')=>`<img class="${cls}" alt="" loading="lazy" src="https://a.espncdn.com/i/teamlogos/nhl/500/${(LOGO[ab]||ab).toLowerCase()}.png" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'logo-fallback',textContent:'${ab}'}))">`;
const ALL=['ANA','BOS','BUF','CAR','CBJ','CGY','CHI','COL','DAL','DET','EDM','FLA','LAK','MIN','MTL','NJD','NSH','NYI','NYR','OTT','PHI','PIT','SEA','SJS','STL','TBL','TOR','UTA','VAN','VGK','WPG','WSH'];
let DATA=null,G=[],P={},LIVE=null,seg='ml',cur=null,mmMode='all';
let FOLLOW=[];try{FOLLOW=JSON.parse(localStorage.getItem('tc_follow')||'[]')}catch(e){}
const following=ab=>FOLLOW.includes(ab);

/* ---------- boot ---------- */
(async function boot(){
  let idx={dates:[]};try{idx=await (await fetch('data/index.json',{cache:'no-store'})).json()}catch(e){}
  const dates=(idx.dates||[]).slice().sort();
  const q=new URLSearchParams(location.search).get('date');
  const todayET=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date());
  let pick=q&&dates.includes(q)?q:(dates.filter(d=>d>=todayET)[0]||dates[dates.length-1]);
  const sel=$('#daySel');sel.innerHTML=dates.map(d=>`<option value="${d}"${d===pick?' selected':''}>${fmtDate(d)}</option>`).join('')||'<option>No slates</option>';
  sel.onchange=()=>{history.replaceState(null,'','?date='+sel.value);loadDay(sel.value)};
  if(pick)await loadDay(pick);
  renderTeams();loadLive();setInterval(loadLive,5*60*1000);
})();
function fmtDate(d){const [y,m,dd]=d.split('-').map(Number);return new Date(Date.UTC(y,m-1,dd,12)).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}
async function loadDay(date){
  try{DATA=await (await fetch(`data/${date}.json`,{cache:'no-store'})).json()}catch(e){$('#rows').innerHTML='<div class="empty"><b>No board for this date</b>The pipeline hasn\'t published a slate yet.</div>';return}
  G=DATA.games||[];P=DATA.params||{};
  G.forEach(g=>{g.L=g.lines||{};const mh=g.home_win;g.winner=mh>=.5?g.ha:g.aa;g.winP=mh>=.5?mh:1-mh;g.mktFav=g.mkt_home==null?null:(g.mkt_home>=.5?g.ha:g.aa);const m=(g.puck_et||'7:00').match(/(\d+):(\d+)/);let h=+m[1];if(h<12)h+=12;g.tsort=h*60+ +m[2]});
  $('#strip').innerHTML=`<b>${G.length} games</b> · ${esc(DATA.label||DATA.date)} · lines in model as of ${esc((G[0]&&G[0].L.books||'').replace(/Primary.*$/,'').replace('Game lines posted as of ','')||'—')} · <span id="livestamp">live odds: connecting…</span>`;
  $('#disc').innerHTML=`<b>Early-season warning:</b> ratings are preseason projections until real games replace them, and most goalie starts are projected, not confirmed. Model-vs-market EV is analysis, not a picks product.`+(DATA.update&&DATA.update.at?`<br><b>Goalie update ${esc(DATA.update.at)}:</b> ${esc(DATA.update.text||'')}`:'');
  renderSummary();renderRows();renderPicks();renderGoalies();renderRatings();renderNews();renderMethod();renderBest();
  const first=new URLSearchParams(location.search).get('g');if(first&&G.find(x=>x.id===first))openGame(first);else{cur=null;$('#gamepanel').hidden=true}
  applyLive();
}

/* ---------- helpers ---------- */
function evs(o){return o?`${o.ev>=0?'+':''}${(o.ev*100).toFixed(1)}%`:'—'}
function pickLabel(p){if(!p)return '—';if(p.market==='ml')return `${p.side} ML`;if(p.market==='p1')return `1P ${p.side} ${p.line}`;if(p.market==='reg3')return p.side==='Tie'?'60-min tie':`${p.side} in 60`;if(p.market==='pl')return `${p.side} ${p.line>0?'+':''}${p.line}`;return `${p.side} ${p.line}`}
function flags(g){const f=[];const s=g.sys||{};
  ['ml','total','p1','reg3'].forEach(k=>{const o=s[k];if(o&&o.tier==='play')f.push(`<span class="pill sys">SYS ${esc(pickLabel(o))}</span>`)});
  if((g.notes||[]).some(n=>/not confirmed/.test(n)))f.push('<span class="pill q">Goalie TBD</span>');
  if(g.mkt_home!=null&&Math.abs(g.home_win-g.mkt_home)>=.08)f.push(`<span class="pill gap">Model ${g.home_win>g.mkt_home?g.ha:g.aa} +${Math.round(Math.abs(g.home_win-g.mkt_home)*100)}</span>`);
  const lv=liveFor(g);if(lv&&lv.moved)f.push(`<span class="pill tot">Line moved</span>`);
  if(following(g.aa)||following(g.ha))f.push('<span class="pill mine">Following</span>');
  return f.join(' ')||'<span class="muted">—</span>'}
function bestOpt(g){return (g.options||[]).reduce((b,o)=>!b||o.ev>b.ev?o:b,null)}
function bars(arr,labels,mark){const W=360,H=120,Pd=18,n=arr.length,bw=(W-2*Pd)/n,mx=Math.max(...arr,1);
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${arr.map((c,i)=>{const h=(c/mx)*(H-38);return `<rect x="${(Pd+i*bw+1).toFixed(1)}" y="${(H-22-h).toFixed(1)}" width="${(bw-2).toFixed(1)}" height="${h.toFixed(1)}"${mark&&mark(i)?' class="mark"':''}/><text x="${(Pd+i*bw+bw/2).toFixed(1)}" y="${H-8}" text-anchor="middle">${labels[i]}</text>`}).join('')}<line x1="${Pd}" x2="${W-Pd}" y1="${H-22}" y2="${H-22}" stroke="#e1e8e5"/></svg>`}
function st(s){s=String(s).toLowerCase();if(/out|ir/.test(s))return 'out';if(/expected|available|probable|confirmed/.test(s))return 'ok';if(/unconfirmed|—|none/.test(s))return '';return 'q'}
function pcol(p,dir){if(dir==='neutral')return '#66758a';const d=Math.abs(p-50)/50;return `hsl(${p>=50?160:6} ${Math.round(18+d*55)}% ${p>=50?32:46}%)`}
function tier(p,dir){if(dir==='neutral')return p>=67?'fast':p<=33?'slow':'avg';return p>=85?'elite':p>=65?'good':p>=35?'avg':p>=15?'weak':'poor'}
function pbar(label,c,dir){if(!c)return `<div class="pbar"><span class="tm">${label}</span><div class="track"></div><span class="pv muted">—</span></div>`;
  return `<div class="pbar"><span class="tm">${label}</span><div class="track"><i style="width:${Math.max(3,c.pct)}%;background:${pcol(c.pct,dir)}"></i></div><span class="pv"><b>${c.pct}</b> <span class="muted">${tier(c.pct,dir)} · ${c.v}</span></span></div>`}
function teamCards(g){const M=DATA.card_meta||[],A=(g.cards||{}).away||{},H=(g.cards||{}).home||{};if(!M.length)return '<div class="muted">No team stats loaded.</div>';
  return `<div class="tcards">${M.map(m=>`<div class="trow"><div class="tl">${esc(m.label)}</div>${pbar(g.aa,A[m.key],m.dir)}${pbar(g.ha,H[m.key],m.dir)}</div>`).join('')}</div>`}
function goalieCard(g,sd){const x=(g.gcards||{})[sd],raw=(g.goalies||{})[sd]||{},ab=sd==='away'?g.aa:g.ha;
  if(!x)return `<div class="card"><div class="k">${logo(ab)} ${ab} goalie</div><div class="v">${esc(raw.name||'TBD')}</div><div class="s">No data.</div></div>`;
  const stp=x.status==='confirmed'?'<span class="pill ok">Confirmed</span>':x.status==='projected'?'<span class="pill q">Projected</span>':'<span class="pill">Unknown</span>';
  const line=(o,lbl)=>o?`${lbl}: GSAx <b>${o.gsax>0?'+':''}${o.gsax}</b> in ${o.gp} GP${o.team?` (${esc(o.team)})`:''}`:`${lbl}: —`;
  return `<div class="card"><div class="k">${logo(ab)} ${ab} goalie ${stp}${x.b2b?' <span class="pill out">Back-to-back</span>':''}</div><div class="v">${esc(x.name)}</div>
   ${x.pct!=null?`<div title="Percentile of GSAx per game among ${x.pool} goalies (${x.basis})">${pbar('GSAx',{pct:x.pct,v:(()=>{const o=x.cur&&x.basis==='2026-27'?x.cur:x.last;return o?(o.gsax>0?'+':'')+o.gsax:''})()},'up')}</div>`:''}
   <div class="s" style="margin-top:6px">${line(x.last,'Last season')}${x.sv_last?` · SV% ${x.sv_last.toFixed(3).replace(/^0/,'')}`:''}<br>${line(x.cur,'This season')}<br>Model adj: <b>${sgn((g.goalie_adj||{})[sd])}</b> goals/gm to the other side's expected goals</div>
   ${raw.note?`<details style="margin-top:6px"><summary class="muted" style="cursor:pointer;font-size:12.5px">Notes</summary><div class="s">${esc(raw.note)}</div></details>`:''}</div>`}
function sysPanel(g){const s=g.sys||{};const row=(o,l)=>o?`<div><b>${l}:</b> ${esc(pickLabel(o))} ${odds(o.odds)} <span class="muted">(${pct(o.prob)} model, EV ${evs(o)})</span> ${o.tier==='play'?'<span class="pill sys">Play</span>':'<span class="pill">Lean</span>'}</div>`:'';
  return `<div class="panel"><h3 style="margin-bottom:6px">System pick</h3>${row(s.ml,'Moneyline')}${row(s.total,'Total')}${row(s.p1,'1st period')}${row(s.reg3,'3-way (60 min)')}${!s.p1&&!s.reg3?'<div class="muted" style="font-size:13px">1st-period and 3-way lines not posted yet.</div>':''}</div>`}
function shopPanel(g){const B=g.books_prices||[],S=g.shop||{};const lv=liveFor(g);
  if(!B.length&&!lv)return `<div class="panel"><h3 style="margin-bottom:6px">Line shop</h3><div class="muted" style="font-size:13px">No per-book prices for this game yet.</div></div>`;
  if(lv){const rows=lv.books.map(b=>`<tr><td>${esc(b.title)}</td><td class="num${b.ml_away===lv.best.ml_away?' better':''}">${odds(b.ml_away)}</td><td class="num${b.ml_home===lv.best.ml_home?' better':''}">${odds(b.ml_home)}</td><td class="num">${b.pl_home!=null?`${g.ha} ${b.pl_home>0?'+':''}${b.pl_home} ${odds(b.pl_home_odds)}`:'—'}</td><td class="num">${b.total??'—'}</td><td class="num${b.over===lv.best.over&&b.total===lv.cons.total?' better':''}">${odds(b.over)}</td><td class="num${b.under===lv.best.under&&b.total===lv.cons.total?' better':''}">${odds(b.under)}</td></tr>`).join('');
    const evl=(p,o)=>{const e=evOf(p,o);return e==null?'—':`${e>0?'+':''}${(e*100).toFixed(1)}%`};
    return `<div class="panel" style="min-width:0"><h3 style="margin-bottom:6px">Line shop <span class="pill tot">live · ${esc(lv.at)}</span></h3><div style="overflow-x:auto"><table class="adv"><thead><tr><th>Book</th><th>${g.aa} ML</th><th>${g.ha} ML</th><th>Puck line</th><th>Total</th><th>Over</th><th>Under</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div style="font-size:13px;margin-top:8px;display:grid;gap:3px"><div><b>No-vig consensus:</b> ${g.ha} ${pct(lv.cons.fair_home)} · ${g.aa} ${pct(1-lv.cons.fair_home)} · total ${lv.cons.total??'—'}</div>
    <div><b>Best ${g.aa}</b> ${odds(lv.best.ml_away)}: model EV ${evl(1-g.home_win,lv.best.ml_away)} · <b>Best ${g.ha}</b> ${odds(lv.best.ml_home)}: model EV ${evl(g.home_win,lv.best.ml_home)}</div>
    ${lv.cons.total===g.L.total?`<div><b>Best over ${lv.cons.total}</b> ${odds(lv.best.over)}: model EV ${evl(g.over,lv.best.over)} · <b>best under</b> ${odds(lv.best.under)}: model EV ${evl(1-g.over-(g.push_total||0),lv.best.under)}</div>`:`<div class="muted">Consensus total ${lv.cons.total} differs from the modeled line ${g.L.total}; total EV is re-priced on the next pipeline run.</div>`}
    <div class="muted">Best price = highest payout across books at the consensus line. Model EV uses the morning simulation; the market, not the model, moves between runs.</div></div></div>`}
  const hi=(v,best)=>v!=null&&best!=null&&v===best?' class="num better"':' class="num"';const m=S.ml||{},t=S.total||{};
  const rows=B.map(b=>`<tr><td>${esc(b.book)}${b.sharp?' <span class="pill">sharp</span>':''}</td><td${hi(b.ml_away,(m.away||{}).best)}>${odds(b.ml_away)}</td><td${hi(b.ml_home,(m.home||{}).best)}>${odds(b.ml_home)}</td><td class="num">${b.total??'—'}</td><td${hi(b.total===t.line?b.over_odds:null,(t.over||{}).best)}>${odds(b.over_odds)}</td><td${hi(b.total===t.line?b.under_odds:null,(t.under||{}).best)}>${odds(b.under_odds)}</td></tr>`).join('');
  return `<div class="panel" style="min-width:0"><h3 style="margin-bottom:6px">Line shop</h3><div style="overflow-x:auto"><table class="adv"><thead><tr><th>Book</th><th>${g.aa} ML</th><th>${g.ha} ML</th><th>Total</th><th>Over</th><th>Under</th></tr></thead><tbody>${rows}</tbody></table></div></div>`}

/* ---------- live odds ---------- */
const norm=s=>String(s||'').toLowerCase().replace(/[^a-z]/g,'');
function liveFor(g){if(!LIVE||!LIVE.games)return null;return LIVE.games.find(x=>norm(x.home)===norm(g.home)&&norm(x.away)===norm(g.away))||null}
async function loadLive(){try{const r=await fetch('/.netlify/functions/odds',{cache:'no-store'});if(!r.ok)throw 0;LIVE=await r.json();LIVE.games.forEach(x=>{x.moved=(x.moves||[]).length>0});}catch(e){LIVE=null}applyLive()}
function applyLive(){
  const stamp=LIVE&&LIVE.at?`live odds ${ago(LIVE.at)} · ${LIVE.snapshots||0} snapshots`:'live odds offline';
  const el=$('#livestamp');if(el)el.textContent=stamp;$('#mmstat').textContent=LIVE?`${(LIVE.games||[]).length} games priced · ${ago(LIVE.at)}`:'feed offline';
  renderMoves();if(G.length){renderRows();if(cur)openGame(cur,true)}
}
function ago(iso){if(!iso)return '—';const m=Math.round((Date.now()-Date.parse(iso))/60000);return m<1?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:`${Math.round(m/1440)} d ago`}
function renderMoves(){const box=$('#moves');if(!LIVE||!LIVE.games){box.innerHTML='<div class="empty"><b>Checking market connection</b>Waiting for the first odds snapshot.</div>';return}
  let items=[];LIVE.games.forEach(x=>{(x.moves||[]).forEach(m=>items.push({...m,home:x.home,away:x.away,ha:x.ha,aa:x.aa,commence:x.commence}))});
  if(mmMode==='mine')items=items.filter(m=>following(m.ha)||following(m.aa));
  items.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  if(!items.length){box.innerHTML=`<div class="empty"><b>No observed moves yet</b>${LIVE.snapshots>1?'Consensus lines are steady since the first snapshot.':'History starts after consecutive snapshots.'}</div>`;return}
  box.innerHTML=items.slice(0,14).map(m=>`<div class="move"><span class="d ${m.dir}">${esc(m.label)}</span><span><b>${esc(m.aa)} @ ${esc(m.ha)}</b><br><span class="muted" style="font-size:11.5px">${esc(m.market)} · ${ago(m.at)}</span></span><span class="m">${esc(m.from)} → ${esc(m.to)}</span></div>`).join('')}

/* ---------- board ---------- */
function renderSummary(){const L=(g,l,v)=>`<li><button class="linkbtn" data-open="${g.id}">${l}</button><span class="v">${v}</span></li>`;
  const ev=G.flatMap(g=>(g.options||[]).map(o=>({g,o}))).sort((a,b)=>b.o.ev-a.o.ev).slice(0,6);
  const gaps=[...G].filter(g=>g.mkt_home!=null).sort((a,b)=>Math.abs(b.home_win-b.mkt_home)-Math.abs(a.home_win-a.mkt_home)).slice(0,6);
  const tot=[...G].filter(g=>g.L.total!=null).sort((a,b)=>Math.abs(b.model_total-b.L.total)-Math.abs(a.model_total-a.L.total)).slice(0,6);
  $('#summary').innerHTML=`<div class="sumcard"><h3>Best model EV</h3><ol>${ev.map(({g,o})=>L(g,`${g.aa}@${g.ha} ${pickLabel(o)} ${odds(o.odds)}`,evs(o))).join('')}</ol></div>`+
   `<div class="sumcard"><h3>Win-prob gaps</h3><ol>${gaps.map(g=>L(g,`${g.aa}@${g.ha} ${g.ha} mkt ${pct(g.mkt_home)}`,`model ${pct(g.home_win)}`)).join('')}</ol></div>`+
   `<div class="sumcard"><h3>Total gaps</h3><ol>${tot.map(g=>L(g,`${g.aa}@${g.ha} ${g.L.total}`,`model ${g.model_total.toFixed(2)}`)).join('')}</ol></div>`}
function segCell(g){const lv=liveFor(g),live=lv?lv.cons:null;
  if(seg==='ml'){const a=live&&live.ml_away!=null?live.ml_away:g.L.ml_away,h=live&&live.ml_home!=null?live.ml_home:g.L.ml_home;return `<span class="num">${odds(a)}</span><span class="num">${odds(h)}</span>`}
  if(seg==='pl'){if(!g.L.pl_fav)return '<span class="muted">—</span><span></span>';const favHome=g.L.pl_fav===g.ha;return `<span class="num">${favHome?'+1.5 '+odds(g.L.pl_odds_dog):'−1.5 '+odds(g.L.pl_odds_fav)}</span><span class="num">${favHome?'−1.5 '+odds(g.L.pl_odds_fav):'+1.5 '+odds(g.L.pl_odds_dog)}</span>`}
  const t=live&&live.total!=null?live.total:g.L.total;return `<span class="num">O ${t??'—'} ${odds(live&&live.over!=null?live.over:g.L.over_odds)}</span><span class="num">U ${t??'—'} ${odds(live&&live.under!=null?live.under:g.L.under_odds)}</span>`}
function renderRows(){const gl=x=>{const s=x.status==='confirmed'?'':' <span class="q">?</span>';return `<span>${esc(x.name||'TBD')}${s}</span>`};
  $('#rows').innerHTML=[...G].sort((a,b)=>a.tsort-b.tsort).map(g=>{const ga=(g.goalies||{}).away||{},gh=(g.goalies||{}).home||{};const fav=following(g.aa)||following(g.ha);
   return `<div class="game-row${cur===g.id?' chosen':''}" data-open="${g.id}" tabindex="0" role="button">
    <div class="game-time">${g.puck_et} ET<small>${esc((g.tv||'').split(';')[0].slice(0,14))}</small></div>
    <div class="team-lines c-teams"><span>${logo(g.aa)}<strong>${esc(g.away)}</strong><span class="rec">${esc((g.records||[])[0]||'')}</span></span><span>${logo(g.ha)}<strong>${esc(g.home)}</strong><span class="rec">${esc((g.records||[])[1]||'')}</span></span></div>
    <div class="cell-lines goalie-cell c-goalie">${gl(ga)}${gl(gh)}</div>
    <div class="cell-lines c-ml">${segCell(g)}</div>
    <div class="cell-lines pct-cell c-win">${[[g.mkt_home!=null?1-g.mkt_home:null,1-g.home_win],[g.mkt_home,g.home_win]].map(([mk,md])=>`<span><strong class="muted" title="market (no-vig)">${pct(mk)}</strong><i><b style="width:${Math.round((md||0)*100)}%"></b></i><strong title="model">${pct(md)}</strong></span>`).join('')}</div>
    <div class="cell-lines c-total"><span class="num">${g.L.total??'—'} <span class="muted">line</span></span><span class="num">${g.model_total.toFixed(2)} <span class="muted">model</span></span></div>
    <div class="flags c-flags">${flags(g)}</div>
    <div class="row-open">→</div></div>`}).join('');
  $('#segHead').textContent=seg==='ml'?'Moneyline':seg==='pl'?'Puck line':'Total'}
function renderBest(){const all=G.flatMap(g=>(g.options||[]).map(o=>({g,o}))).filter(x=>x.o.tier==='play').sort((a,b)=>b.o.ev-a.o.ev);
  $('#bestbox').innerHTML=all.length?`<ul class="plain" style="padding-left:0;list-style:none">${all.slice(0,6).map(({g,o})=>`<li style="display:flex;justify-content:space-between;gap:8px;border-bottom:1px dashed var(--line);padding:5px 0"><button class="linkbtn" data-open="${g.id}">${logo(o.side===g.ha||o.side===g.aa?o.side:g.ha)} ${esc(pickLabel(o))} ${odds(o.odds)}</button><span class="num" style="font-weight:600">${evs(o)}</span></li>`).join('')}</ul><p class="hint" style="margin:8px 0 0">System plays clearing +${((P.PLAY_EV||.04)*100).toFixed(0)}% EV at this morning's prices.</p>`:'<span class="muted">No plays clear the EV threshold on this slate.</span>'}

/* ---------- game page ---------- */
function gameSections(g){const a=g.r_away,h=g.r_home,f1=x=>x.toFixed(2);const adv=(l,x,y,low)=>`<tr><td>${l}</td><td class="num ${(low?x<y:x>y)?'better':''}">${f1(x)}</td><td class="num ${(low?y<x:y>x)?'better':''}">${f1(y)}</td></tr>`;
  const T=g.hist_total,Mg=g.hist_margin,lv=liveFor(g);
  const grid=`<div class="grid8">
    <div class="cell"><div class="k">Moneyline${lv?' · live':''}</div><div class="val">${g.aa} ${odds(lv?lv.cons.ml_away:g.L.ml_away)} / ${g.ha} ${odds(lv?lv.cons.ml_home:g.L.ml_home)}</div><div class="sub">no-vig ${g.ha} ${pct(lv?lv.cons.fair_home:g.mkt_home)}</div></div>
    <div class="cell"><div class="k">Model win</div><div class="val">${g.winner} ${pct(g.winP)}</div><div class="sub">incl. OT/SO · 60-min tie ${pct(g.reg_draw)}</div></div>
    <div class="cell"><div class="k">Proj goals</div><div class="val">${g.proj_away.toFixed(1)}–${g.proj_home.toFixed(1)}</div><div class="sub">total ${g.model_total.toFixed(2)} vs ${g.L.total??'—'}</div></div>
    <div class="cell"><div class="k">Total${lv?' · live':''}</div><div class="val">O ${lv&&lv.cons.total!=null?lv.cons.total:(g.L.total??'—')} ${odds(lv&&lv.cons.over!=null?lv.cons.over:g.L.over_odds)}</div><div class="sub">model over ${pct(g.over)}${g.push_total?` · push ${pct(g.push_total)}`:''}</div></div>
    <div class="cell"><div class="k">Puck line</div><div class="val">${g.L.pl_fav?`${g.L.pl_fav} −1.5 ${odds(g.L.pl_odds_fav)}`:'—'}</div><div class="sub">model covers ${pct(g.pl_fav_cover)}</div></div>
    <div class="cell"><div class="k">1st period</div><div class="val">${g.p1_line?`Over ${g.p1_line.total} ${pct(g.p1_line.over)}`:`Over 1.5 ${pct(g.p1_over_15)}`}</div><div class="sub">${g.p1_line?`posted ${g.p1_line.total}`:`any goal ${pct(g.p1_over_05)} · no line posted`}</div></div>
    <div class="cell"><div class="k">3-way (60 min)</div><div class="val">Tie ${pct(g.reg_draw)}</div><div class="sub">model ${g.aa} ${pct(g.reg_away)} · ${g.ha} ${pct(g.reg_home)}</div></div>
    <div class="cell"><div class="k">Empty net</div><div class="val">${g.en?g.en.goals_pg.toFixed(2):'—'} / game</div><div class="sub">${g.en?`pulled down 1 in ${pct(g.en.pull_d1)} · ties after pull ${pct(g.en.tie_after_pull)}`:''}</div></div></div>`;
  const read=`<div class="read"><b>Sim read</b><br>Model has <b>${g.winner}</b> winning ${pct(g.winP)}${g.mkt_home!=null?` vs a no-vig market ${pct(g.home_win>=.5?g.mkt_home:1-g.mkt_home)}`:''}. Expected goals ${g.aa} ${g.lam_away} – ${g.ha} ${g.lam_home}. Best EV on the board for this game: ${(g.options||[]).length?(()=>{const o=[...g.options].sort((x,y)=>y.ev-x.ev)[0];return `<b>${esc(pickLabel(o))} ${odds(o.odds)}</b> at ${evs(o)}`})():'no lines yet'}.</div>`;
  const overview=`${grid}<div class="two"><div class="stack">${read}${sysPanel(g)}${g.note?`<div class="note"><b>Notebook:</b> ${esc(g.note)}</div>`:''}
    <dl class="kv"><dt>Spot</dt><dd>${esc(g.spot||'—')}</dd><dt>Rest</dt><dd>${esc((g.rest||{}).away_travel||'—')}</dd><dt>Series</dt><dd>${esc((g.series||{}).last_season||'—')}${(g.series||{}).note?' · '+esc(g.series.note):''}</dd>${(g.notes||[]).length?`<dt>Flags</dt><dd>${g.notes.map(esc).join('<br>')}</dd>`:''}</dl></div>
    <div class="stack"><div><h3>Team profile</h3><div class="muted" style="font-size:12.5px;margin:-4px 0 8px">Percentile vs all 32 teams (100 = best; pace is just faster/slower). Stats: ${esc(DATA.card_season||'')}.</div>${teamCards(g)}
     <table class="adv" style="margin-top:12px"><thead><tr><th></th><th>${g.aa}</th><th>${g.ha}</th></tr></thead><tbody>${adv('Projected points',a.pts,h.pts)}${(a.gp||h.gp)?adv('This season xGF / game',a.xgf_pg||0,h.xgf_pg||0)+adv('This season xGA / game (lower better)',a.xga_pg||0,h.xga_pg||0,true):''}
      <tr><td>Rating built from</td><td class="num">${Math.round((1-a.w_actual)*100)}% proj · ${Math.round(a.w_actual*100)}% actual${a.gp?` (${a.gp} GP)`:''}</td><td class="num">${Math.round((1-h.w_actual)*100)}% proj · ${Math.round(h.w_actual*100)}% actual${h.gp?` (${h.gp} GP)`:''}</td></tr>
      <tr><td>Goalie adj (goals/gm)</td><td class="num">${sgn((g.goalie_adj||{}).away)}</td><td class="num">${sgn((g.goalie_adj||{}).home)}</td></tr></tbody></table></div></div></div>`;
  const movesHtml=lv&&(lv.moves||[]).length?`<div class="panel"><h3 style="margin-bottom:6px">Market moves</h3>${lv.moves.map(m=>`<div class="move"><span class="d ${m.dir}">${esc(m.label)}</span><span>${esc(m.market)}<br><span class="muted" style="font-size:11.5px">${ago(m.at)}</span></span><span class="m">${esc(m.from)} → ${esc(m.to)}</span></div>`).join('')}</div>`:`<div class="panel"><h3 style="margin-bottom:6px">Market moves</h3><div class="muted" style="font-size:13px">${LIVE?'No consensus movement observed on this game yet.':'Live odds feed offline; showing the morning lines.'}</div></div>`;
  const oddsTab=`<div class="two"><div class="stack">${shopPanel(g)}<dl class="kv"><dt>Morning lines</dt><dd class="num" style="font-size:12.5px">${esc(g.L.open||'')}</dd><dt>Sourcing</dt><dd style="font-size:12.5px">${esc(g.L.books||'')}</dd></dl></div><div class="stack">${movesHtml}${sysPanel(g)}</div></div>`;
  const totals=`<div class="two"><div class="stack"><div class="hist"><h3>Total goals (sims)</h3>${bars(T,T.map((_,i)=>i===12?'12+':i),i=>g.L.total!=null&&i>g.L.total)}</div><div class="hist"><h3>Final margin (${g.ha} − ${g.aa})</h3>${bars(Mg,Mg.map((_,i)=>i-5===-5?'≤−5':i-5===5?'≥5':i-5),i=>i-5>0)}</div>${g.hist_p1?`<div class="hist"><h3>1st-period goals (sims)</h3>${bars(g.hist_p1,g.hist_p1.map((_,i)=>i===g.hist_p1.length-1?i+'+':i),i=>i>=2)}</div>`:''}</div>
    <div class="stack"><div class="panel"><h3 style="margin-bottom:8px">Second intermission</h3><div class="ht"><div><div class="k">${esc(g.ref)} trails after 2</div><div class="v">${pct(g.i2_trail)}</div><div class="s">wins from behind ${pct(g.i2_comeback)}</div></div><div><div class="k">Leads after 2 → wins</div><div class="v">${pct(g.i2_hold)}</div><div class="s">tied after 2: ${pct(g.i2_tied)}</div></div></div></div>
    <div class="panel"><h3 style="margin-bottom:8px">Alternate totals (model)</h3><table class="adv"><thead><tr><th>Line</th><th>Over</th><th>Push</th><th>Under</th></tr></thead><tbody>${[5.5,6,6.5,7,7.5].map(l=>{const n=T.reduce((s,c)=>s+c,0)||1;const ov=T.reduce((s,c,i)=>s+(i>l?c:0),0)/n,pu=T.reduce((s,c,i)=>s+(i===l?c:0),0)/n;return `<tr><td class="num">${l}</td><td class="num">${pct(ov)}</td><td class="num">${pct(pu)}</td><td class="num">${pct(1-ov-pu)}</td></tr>`}).join('')}</tbody></table><div class="muted" style="font-size:12px;margin-top:6px">From the same 40,000 sims; the 12+ bucket is treated as 12.</div></div></div></div>`;
  const goalies=`<div class="gl">${['away','home'].map(sd=>goalieCard(g,sd)).join('')}</div><p class="hint" style="margin-top:10px">${(g.goalie_why||{}).away?esc(g.aa+': '+g.goalie_why.away)+' · ':''}${(g.goalie_why||{}).home?esc(g.ha+': '+g.goalie_why.home):''}</p>`;
  const news=`<div class="two"><div class="stack"><div><h3>Injuries</h3><table class="inj"><tbody>${(g.inj||[]).map(i=>`<tr><td>${esc(i[0])}</td><td>${esc(i[1])}</td><td><span class="pill ${st(i[2])}">${esc(i[2])}</span></td></tr>`).join('')||'<tr><td></td><td class="muted">No confirmed reports</td><td></td></tr>'}</tbody></table></div>${(g.news||[]).length?`<div><h3>This week</h3><ul class="plain">${g.news.map(n=>`<li>${esc(n)}</li>`).join('')}</ul></div>`:''}</div>
    <div class="stack"><div><h3>Fresh reads</h3><ul class="plain">${[g.away,g.home].map(t=>`<li><a href="https://news.google.com/search?q=${encodeURIComponent('"'+t+'" when:2d')}&hl=en-US&gl=US&ceid=US:en" target="_blank" rel="noopener">${esc(t)}: last 48 hours</a></li>`).join('')}${[(g.goalies||{}).away,(g.goalies||{}).home].filter(x=>x&&x.name).map(x=>`<li><a href="https://news.google.com/search?q=${encodeURIComponent('"'+x.name+'" when:3d')}&hl=en-US&gl=US&ceid=US:en" target="_blank" rel="noopener">${esc(x.name)}: goalie news</a></li>`).join('')}</ul></div><div class="srcs"><b>Sources:</b> ${(g.src||[]).map(u=>{try{return `<a href="${esc(u)}" target="_blank" rel="noopener">${new URL(u).hostname.replace('www.','')}</a>`}catch(e){return ''}}).join(' · ')}</div></div></div>`;
  return {overview,odds:oddsTab,totals,goalies,news}}
let gtab='overview';
function openGame(id,quiet){const g=G.find(x=>x.id===id);if(!g)return;cur=id;const ORDER=[...G].sort((a,b)=>a.tsort-b.tsort).map(x=>x.id);const i=ORDER.indexOf(id);
  $('#gamepanel').hidden=false;$('#gtitle').textContent=`${g.away} at ${g.home}`;$('#gwhen').textContent=`${fmtDate(g.date)} · ${g.puck_et} ET · ${g.tv||''} · ${g.arena||''}`;
  $('#pair').innerHTML=`<div>${logo(g.aa,'big-logo')}<span><small>${esc(g.away.split(' ').slice(0,-1).join(' '))}</small><strong>${esc(g.away.split(' ').slice(-1)[0])}</strong></span></div><div class="versus"><span>AT</span><b>${g.aa} ${odds(g.L.ml_away)} · ${g.ha} ${odds(g.L.ml_home)}</b><span>${flags(g)}</span></div><div><span><small>${esc(g.home.split(' ').slice(0,-1).join(' '))}</small><strong>${esc(g.home.split(' ').slice(-1)[0])}</strong></span>${logo(g.ha,'big-logo')}</div>`;
  const S=gameSections(g);$('#gameview').innerHTML=Object.keys(S).map(k=>`<div class="tabbody" data-tb="${k}"${k===gtab?'':' hidden'}>${S[k]}</div>`).join('');
  document.querySelectorAll('#gtabs button').forEach(b=>b.classList.toggle('active',b.dataset.t===gtab));
  $('#gprev').disabled=i<=0;$('#gnext').disabled=i>=ORDER.length-1;$('#gprev').dataset.id=ORDER[i-1]||'';$('#gnext').dataset.id=ORDER[i+1]||'';
  document.querySelectorAll('.game-row').forEach(r=>r.classList.toggle('chosen',r.dataset.open===id));
  history.replaceState(null,'',`?date=${DATA.date}&g=${id}`);
  if(!quiet){show('board');$('#gamepanel').scrollIntoView({behavior:'smooth',block:'start'})}}

/* ---------- other views ---------- */
function renderPicks(){const rows=[];G.forEach(g=>['ml','total','p1','reg3'].forEach(k=>{const o=(g.sys||{})[k];if(o)rows.push({g,o})}));rows.sort((a,b)=>b.o.ev-a.o.ev);
  $('#systab tbody').innerHTML=rows.map(({g,o})=>`<tr class="clickrow" data-open="${g.id}"><td style="display:flex;gap:6px;align-items:center">${logo(g.aa)}${g.aa} @ ${logo(g.ha)}${g.ha}</td><td class="num">${g.puck_et}</td><td class="num"><b>${esc(pickLabel(o))}</b></td><td class="num">${odds(o.odds)}</td><td class="num">${pct(o.prob)}</td><td class="num">${evs(o)}</td><td>${o.tier==='play'?'<span class="pill sys">Play</span>':'<span class="pill">Lean</span>'}</td></tr>`).join('')||'<tr><td colspan="7" class="muted">No system picks on this slate.</td></tr>'}
function renderGoalies(){const rows=[];[...G].sort((a,b)=>a.tsort-b.tsort).forEach(g=>['away','home'].forEach(sd=>{const x=(g.gcards||{})[sd]||{},raw=(g.goalies||{})[sd]||{};const ab=sd==='away'?g.aa:g.ha;rows.push(`<tr class="clickrow" data-open="${g.id}"><td>${g.aa} @ ${g.ha}</td><td style="display:flex;gap:6px;align-items:center">${logo(ab)}${ab}</td><td><b>${esc(x.name||raw.name||'TBD')}</b></td><td>${x.status==='confirmed'?'<span class="pill ok">Confirmed</span>':x.status==='projected'?'<span class="pill q">Projected</span>':'<span class="pill">Unknown</span>'}${x.b2b?' <span class="pill out">B2B</span>':''}</td><td class="num" style="font-size:12.5px">${x.last?`GSAx ${x.last.gsax>0?'+':''}${x.last.gsax} / ${x.last.gp} GP${x.sv_last?' · SV '+x.sv_last.toFixed(3).replace(/^0/,''):''}`:'—'}</td><td class="num">${sgn((g.goalie_adj||{})[sd])}</td><td style="white-space:normal;max-width:420px;font-size:12.5px">${esc(raw.note||'')}</td></tr>`)}));$('#gtab tbody').innerHTML=rows.join('')}
function renderRatings(){const seen={},rows=[];G.forEach(g=>[['away',g.aa,g.r_away,(g.cards||{}).away],['home',g.ha,g.r_home,(g.cards||{}).home]].forEach(([sd,ab,r,c])=>{if(!r||seen[ab])return;seen[ab]=1;c=c||{};rows.push({ab,r,c})}));rows.sort((a,b)=>b.r.diff-a.r.diff);
  const v=x=>x&&x.v!=null?x.v.toFixed(2):'—';$('#rtab tbody').innerHTML=rows.map(({ab,r,c})=>`<tr><td style="display:flex;gap:8px;align-items:center">${logo(ab)}<b>${ab}</b></td><td class="num">${r.pts}</td><td class="num">${r.gf.toFixed(2)}</td><td class="num">${r.ga.toFixed(2)}</td><td class="num ${r.diff>0?'better':''}">${sgn(r.diff)}</td><td class="num">${v(c.xgf)}</td><td class="num">${v(c.xga)}</td><td class="num">${v(c.pp)}</td><td class="num">${v(c.pk)}</td><td class="num">${v(c.pace)}</td></tr>`).join('')}
function renderNews(){$('#newsview').innerHTML=[...G].sort((a,b)=>a.tsort-b.tsort).map(g=>`<div class="side-card" style="margin-bottom:14px"><h3 style="font-size:20px"><span style="display:flex;gap:8px;align-items:center">${logo(g.aa)}${esc(g.away)} <span class="muted">at</span> ${logo(g.ha)}${esc(g.home)}</span><small>${g.puck_et} ET</small></h3><div class="two"><div><ul class="plain">${(g.news||[]).map(n=>`<li>${esc(n)}</li>`).join('')||'<li class="muted">No notes.</li>'}</ul></div><div><table class="inj"><tbody>${(g.inj||[]).map(i=>`<tr><td>${esc(i[0])}</td><td>${esc(i[1])}</td><td><span class="pill ${st(i[2])}">${esc(i[2])}</span></td></tr>`).join('')||'<tr><td></td><td class="muted">No confirmed injury reports</td><td></td></tr>'}</tbody></table><p style="margin:8px 0 0;font-size:13px"><a href="https://news.google.com/search?q=${encodeURIComponent('"'+g.away+'" OR "'+g.home+'" when:2d')}&hl=en-US&gl=US&ceid=US:en" target="_blank" rel="noopener">Google News: both teams, last 48h →</a> · <button class="linkbtn" data-open="${g.id}">Open game →</button></p></div></div></div>`).join('')}
function renderMethod(){const n=x=>x==null?'—':x;$('#method').innerHTML=`<p><b>Late game and empty nets.</b> The last three minutes of regulation are simulated in 5-second steps. A team down one pulls its goalie with about 1:45 left (down two, about 3:00); with the net empty the trailing team scores at about 6.5 goals per 60 and the leader about 11 per 60 into the empty net, both scaled to team strength. Base rates are trimmed so expected goals don't change; what changes is the shape: more two-goal wins (puck line) and more late goals (totals).</p>
<p><b>Regulation ties.</b> Independent scoring under-produces 60-minute ties, so each game's tie chance is scaled so an average matchup matches last season's overtime rate (${P.OT_RATE?(P.OT_RATE*100).toFixed(1)+'%':'—'}; raw model ${P.REF_TIE?(P.REF_TIE*100).toFixed(1)+'%':'—'}, ×${n(P.TIE_MULT)}). Win % and the 3-way prices use the calibrated number.</p>
<p><b>In-season blend.</b> Each team's goals-for and goals-against rates start as the Kodo Hockey preseason projection and shift toward this season's results as games are played: projection weight = 20 ÷ (games played + 20). "This season" is 70% expected goals + 30% actual goals per game (MoneyPuck). Goalies use GSAx: last season's rate padded with 10 average games, blended the same way, then regressed 50%.</p>
<p><b>Expected goals.</b> <code>λ(home) = ${n(P.LG)} × (GF home ÷ avg) × (GA away ÷ avg) × ${n(P.HFA)}</code>, and the mirror for the road team ÷ ${n(P.HFA)}; rates shrunk 30% toward the league average of ${n(P.LG)} goals per team game.</p>
<p><b>Goalies.</b> Each starter shifts the opponent's λ by goals saved per game vs an average goalie, regressed 50%: GSAx ÷ GP when known, otherwise (save % − .900) × ${n(P.SA)} shots. Unconfirmed starters are flagged; the morning run re-checks them.</p>
<p><b>Game sim.</b> ${P.N?P.N.toLocaleString():'40,000'} sims. Each team's λ gets ±${P.SIG?P.SIG*100:'—'}% lognormal rating noise, then three periods of Poisson goals. Ties go to 3-on-3 overtime (a goal about ${P.P_OT?P.P_OT*100:'—'}% of the time), then a coin-flip shootout. OT and shootout winners get one extra goal in the final score, the way sportsbooks grade puck lines and totals.</p>
<p><b>Market.</b> Moneylines are de-vigged to a fair win %. EV = model probability × payout − (1 − probability), per unit risked. The system logs the best-EV moneyline side and the best-EV total side for every game; <b>plays</b> clear +${((P.PLAY_EV||.04)*100).toFixed(0)}% EV. <b>Live odds</b> refresh every 30 minutes from The Odds API across US books; Market Moves compares the no-vig consensus to the first snapshot of the day.</p>
<p><b>Scorecard.</b> CLV — beating the closing line — is the proof of an edge; win/loss over small samples isn't. Results and CLV are graded daily in the pick tracker.</p>
<p><b>What it ignores.</b> Skater injuries, line changes, travel beyond back-to-backs, and motivation are shown as context only.</p>`}
function renderTeams(){$('#teams').innerHTML=ALL.map(ab=>`<button data-team="${ab}" class="${following(ab)?'on':''}"><span class="star">${following(ab)?'★':'☆'}</span>${ab}</button>`).join('')}

/* ---------- nav / events ---------- */
const VIEWS=['board','picks','record','goalies','ratings','news','method'];
function show(v){VIEWS.forEach(k=>{const el=$('#v-'+k);if(el)el.hidden=k!==v});document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('active',b.dataset.v===v));if(v!=='board')window.scrollTo({top:0})}
document.addEventListener('click',e=>{
  const nb=e.target.closest('#nav button');if(nb){show(nb.dataset.v);return}
  const gt=e.target.closest('[data-goto]');if(gt){e.preventDefault();show(gt.dataset.goto);return}
  const sg=e.target.closest('#seg button');if(sg){seg=sg.dataset.seg;document.querySelectorAll('#seg button').forEach(b=>b.classList.toggle('active',b===sg));renderRows();return}
  const mm=e.target.closest('[data-mm]');if(mm){mmMode=mm.dataset.mm;document.querySelectorAll('[data-mm]').forEach(b=>b.classList.toggle('active',b===mm));renderMoves();return}
  const tb=e.target.closest('#gtabs button');if(tb){gtab=tb.dataset.t;document.querySelectorAll('#gtabs button').forEach(b=>b.classList.toggle('active',b===tb));document.querySelectorAll('.tabbody').forEach(d=>d.hidden=d.dataset.tb!==gtab);return}
  const tm=e.target.closest('[data-team]');if(tm){const ab=tm.dataset.team;FOLLOW=following(ab)?FOLLOW.filter(x=>x!==ab):[...FOLLOW,ab];try{localStorage.setItem('tc_follow',JSON.stringify(FOLLOW))}catch(err){}renderTeams();renderRows();renderMoves();return}
  if(e.target.closest('#gprev')){const id=$('#gprev').dataset.id;if(id)openGame(id);return}
  if(e.target.closest('#gnext')){const id=$('#gnext').dataset.id;if(id)openGame(id);return}
  const op=e.target.closest('[data-open]');if(op&&!e.target.closest('a')){openGame(op.dataset.open);return}
});
document.addEventListener('keydown',e=>{if(e.key==='Enter'){const r=e.target.closest('.game-row');if(r)openGame(r.dataset.open)}});
