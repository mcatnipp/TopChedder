// Grader: finals from the NHL API → grade the day's system picks, closing-line value from our own odds snapshots,
// per-game boxscores kept for phase-2 player models. Keys: results/<date>, box/<gid>, ledger, results-index.
import { imp, novig, payout } from './sim.mts';
import { settle, todayET, addDays, nhlGamesOn, nhlLanding, nhlBoxscore, nhlPlayByPlay, closingFor, boardStore } from './sources.mts';

const r1 = (x: number) => Math.round(x * 10) / 10, r2 = (x: number) => Math.round(x * 100) / 100;
const str = (v: any) => (v && typeof v === 'object') ? (v.default ?? '') : (v ?? '');
const toi = (s: string) => { const m = String(s || '0:00').split(':').map(Number); return m.length === 2 ? m[0] * 60 + m[1] : 0; };
function compactBox(box: any, gid: number, date: string) {
  const side = (t: any, ps: any) => ({ abbrev: t?.abbrev, score: t?.score, sog: t?.sog,
    skaters: [...(ps?.forwards || []), ...(ps?.defense || [])].map((p: any) => ({ id: p.playerId, name: str(p.name), pos: p.position, num: p.sweaterNumber, g: p.goals, a: p.assists, pts: p.points, pm: p.plusMinus, pim: p.pim, hits: p.hits, ppg: p.powerPlayGoals, sog: p.sog, blk: p.blockedShots, toi: toi(p.toi), shifts: p.shifts, fo: p.faceoffWinningPctg ?? null, gv: p.giveaways, tk: p.takeaways })),
    goalies: (ps?.goalies || []).map((p: any) => ({ id: p.playerId, name: str(p.name), num: p.sweaterNumber, starter: !!p.starter, sa: p.shotsAgainst, sv: p.saves, ga: p.goalsAgainst, toi: toi(p.toi), ev: p.evenStrengthShotsAgainst, pp: p.powerPlayShotsAgainst, sh: p.shorthandedShotsAgainst })) });
  return { gid, date, state: box.gameState, last_period: box.periodDescriptor?.periodType, periods: box.periodDescriptor?.number, away: side(box.awayTeam, box.playerByGameStats?.awayTeam), home: side(box.homeTeam, box.playerByGameStats?.homeTeam), captured_at: new Date().toISOString() };
}
function officials(box: any, land: any) { const gi = box?.summary?.gameInfo || land?.summary?.gameInfo || {}; return { referees: (gi.referees || []).map((r: any) => str(r.default ?? r)), linesmen: (gi.linesmen || []).map((r: any) => str(r.default ?? r)) }; }
function compactPBP(pbp: any, gid: number, date: string) {
  const ev = (pbp?.plays || []).filter((p: any) => /shot|goal|penalty|faceoff|hit|giveaway|takeaway|blocked/i.test(p.typeDescKey || '')).map((p: any) => { const d = p.details || {}; return { t: p.typeDescKey, p: p.periodDescriptor?.number, c: p.timeInPeriod, sit: p.situationCode, tm: d.eventOwnerTeamId, x: d.xCoord, y: d.yCoord, zone: d.zoneCode, shot: d.shotType, s: d.shootingPlayerId || d.scoringPlayerId || d.playerId || d.hittingPlayerId || d.winningPlayerId, g: d.goalieInNetId, hs: d.homeScore, as: d.awayScore, pen: d.descKey, pim: d.duration }; });
  return { gid, date, n: ev.length, home_id: pbp?.homeTeam?.id, away_id: pbp?.awayTeam?.id, events: ev, captured_at: new Date().toISOString() };
}
function gradePick(o: any, f: { h: number; a: number; type: string; p1: number | null }, ha: string, aa: string) {
  if (!o) return null; let res: 'W' | 'L' | 'P' | 'NA' = 'NA';
  if (o.market === 'ml') res = (o.side === ha ? f.h > f.a : f.a > f.h) ? 'W' : 'L';
  else if (o.market === 'total') { const t = f.h + f.a; res = t === o.line ? 'P' : (o.side === 'Over' ? t > o.line : t < o.line) ? 'W' : 'L'; }
  else if (o.market === 'pl') { const m = o.side === ha ? f.h - f.a : f.a - f.h; res = (o.line < 0 ? m >= 2 : m >= -1) ? 'W' : 'L'; }
  else if (o.market === 'p1') { if (f.p1 == null) res = 'NA'; else res = f.p1 === o.line ? 'P' : (o.side === 'Over' ? f.p1 > o.line : f.p1 < o.line) ? 'W' : 'L'; }
  else if (o.market === 'tt') { const [team, dir] = String(o.side).split(' '); const goals = team === ha ? f.h : f.a; res = goals === o.line ? 'P' : (dir === 'Over' ? goals > o.line : goals < o.line) ? 'W' : 'L'; }
  else if (o.market === 'reg3') { const reg = f.type === 'REG'; const winner = !reg ? 'Tie' : (f.h > f.a ? ha : aa); res = o.side === winner ? 'W' : 'L'; }
  const units = res === 'W' ? r2(payout(o.odds)) : res === 'L' ? -1 : 0;
  return { ...o, result: res, units };
}
export async function gradeDate(date: string, log: string[]) {
  const store = boardStore(); const board: any = await store.get(`days/${date}`, { type: 'json' }); if (!board) { log.push(`no board for ${date}`); return null; }
  const sched: any[] = await settle(nhlGamesOn(date), [], log, `schedule ${date}`); const games: any[] = []; let complete = true;
  for (const g of board.games || []) {
    const s = sched.find((x: any) => x.id === g.gid) || sched.find((x: any) => x.homeTeam?.abbrev === g.ha && x.awayTeam?.abbrev === g.aa);
    const fin = s && ['OFF', 'FINAL'].includes(s.gameState) && s.homeTeam?.score != null;
    if (!fin) { complete = false; games.push({ id: g.id, gid: g.gid, aa: g.aa, ha: g.ha, puck_utc: g.puck_utc, final: null, state: s?.gameState || 'unknown', picks: [] }); continue; }
    const [land, box] = await Promise.all([settle(nhlLanding(s.id), null, log, `landing ${s.id}`), settle(nhlBoxscore(s.id), null, log, `boxscore ${s.id}`)]);
    const bp = land?.summary?.linescore?.byPeriod || []; const p1 = bp.length ? (bp[0].away ?? 0) + (bp[0].home ?? 0) : null;
    const f = { h: s.homeTeam.score, a: s.awayTeam.score, type: s.gameOutcome?.lastPeriodType || land?.gameOutcome?.lastPeriodType || 'REG', p1 };
    if (box?.playerByGameStats) await settle(store.setJSON(`box/${s.id}`, { ...compactBox(box, s.id, date), officials: officials(box, land) }), undefined, log, `store box ${s.id}`);
    const pbp = await settle(nhlPlayByPlay(s.id), null, log, `pbp ${s.id}`); if (pbp?.plays) await settle(store.setJSON(`pbp/${s.id}`, compactPBP(pbp, s.id, date)), undefined, log, `store pbp ${s.id}`);
    const close = await closingFor((x: any) => x.ha === g.ha && x.aa === g.aa, g.puck_utc || s.startTimeUTC, log);
    const picks: any[] = [];
    for (const k of ['ml', 'total', 'p1', 'reg3', 'tt']) {
      const o = gradePick(g.sys?.[k], f, g.ha, g.aa); if (!o) continue; let clv: number | null = null, closing: any = null;
      if (close) {
        if (o.market === 'ml') { const [ch] = novig(close.cons.ml_home, close.cons.ml_away); const [oh] = novig(g.lines?.ml_home, g.lines?.ml_away); if (ch != null && oh != null) { const pc = o.side === g.ha ? ch : 1 - ch, po = o.side === g.ha ? oh : 1 - oh; clv = r1((pc - po) * 100); closing = { ml_home: close.cons.ml_home, ml_away: close.cons.ml_away, fair_home: r2(ch) }; } }
        if (o.market === 'total' && close.cons.total === o.line) { const [co] = novig(close.cons.over, close.cons.under); const [oo] = novig(g.lines?.over_odds, g.lines?.under_odds); if (co != null && oo != null) { const pc = o.side === 'Over' ? co : 1 - co, po = o.side === 'Over' ? oo : 1 - oo; clv = r1((pc - po) * 100); closing = { total: close.cons.total, over: close.cons.over, under: close.cons.under }; } }
        else if (o.market === 'total') closing = { total: close.cons.total, over: close.cons.over, under: close.cons.under, line_moved: true };
      }
      picks.push({ ...o, clv, closing });
    }
    games.push({ id: g.id, gid: s.id, aa: g.aa, ha: g.ha, puck_utc: g.puck_utc, final: f, state: 'final', model: { home_win: g.home_win, mkt_home: g.mkt_home, model_total: g.model_total, over: g.over, total_line: g.lines?.total ?? null }, closing_at: close?.at || null, picks });
  }
  // personal bet log for the day (POST board?run=bet): graded with the same rules, CLV vs closing consensus
  const bets: any[] = (await settle(store.get(`bets/${date}`, { type: 'json' }) as any, [], log, 'bets')) || [];
  for (const b of bets) { const gm = games.find(x => x.id === b.game); if (!gm || !gm.final) { b.result = 'NA'; continue; } const o = gradePick({ market: b.market, side: b.side, line: b.line ?? null, odds: b.odds }, gm.final, gm.ha, gm.aa); b.result = o?.result || 'NA'; b.units = o ? o.units * (b.stake || 1) : 0;
    if (gm.closing_at) { const cl = await closingFor((x: any) => x.ha === gm.ha && x.aa === gm.aa, gm.puck_utc, log); if (cl && b.market === 'ml') { const [ch] = novig(cl.cons.ml_home, cl.cons.ml_away); if (ch != null) { const pc = b.side === gm.ha ? ch : 1 - ch; b.clv = r1((pc - imp(b.odds)!) * 100); b.closing = { ml_home: cl.cons.ml_home, ml_away: cl.cons.ml_away }; } } if (cl && b.market === 'total' && cl.cons.total === b.line) { const [co] = novig(cl.cons.over, cl.cons.under); if (co != null) { const pc = b.side === 'Over' ? co : 1 - co; b.clv = r1((pc - imp(b.odds)!) * 100); b.closing = { total: cl.cons.total, over: cl.cons.over, under: cl.cons.under }; } } }
  }
  if (bets.length) await store.setJSON(`bets/${date}`, bets);
  // starter-flip events: attach the closing market so the "does a confirmation move the line" question answers itself over time
  const ev: any[] = (await settle(store.get(`starters/${date}`, { type: 'json' }) as any, [], log, 'starters')) || [];
  for (const e of ev) { const gm = games.find(x => x.id === e.game); if (!gm) continue; const cl = await closingFor((x: any) => x.ha === gm.ha && x.aa === gm.aa, gm.puck_utc, log); if (cl) e.market_close = { ml_home: cl.cons.ml_home, ml_away: cl.cons.ml_away, total: cl.cons.total, at: cl.at }; }
  if (ev.length) await store.setJSON(`starters/${date}`, ev);
  const all = games.flatMap(x => x.picks).filter(p => p.result !== 'NA'); const plays = all.filter(p => p.tier === 'play'); const priced = all.filter(p => p.clv != null);
  const sum = (ps: any[]) => ({ w: ps.filter(p => p.result === 'W').length, l: ps.filter(p => p.result === 'L').length, p: ps.filter(p => p.result === 'P').length, units: r2(ps.reduce((s, p) => s + p.units, 0)), risk: ps.filter(p => p.result !== 'P').length });
  const mine = bets.filter(b => b.result && b.result !== 'NA'); const minePriced = mine.filter(b => b.clv != null);
  const res = { date, graded_at: new Date().toISOString(), complete, games, summary: { ...sum(all), plays: sum(plays), clv: priced.length ? r1(priced.reduce((s, p) => s + p.clv, 0) / priced.length) : null, n_clv: priced.length,
    mine: { n: mine.length, w: mine.filter(b => b.result === 'W').length, l: mine.filter(b => b.result === 'L').length, p: mine.filter(b => b.result === 'P').length, units: r2(mine.reduce((s, b) => s + (b.units || 0), 0)), risk: r2(mine.filter(b => b.result !== 'P').reduce((s, b) => s + (b.stake || 1), 0)), clv: minePriced.length ? r1(minePriced.reduce((s, b) => s + b.clv, 0) / minePriced.length) : null, n_clv: minePriced.length } } };
  await store.setJSON(`results/${date}`, res); return res;
}
export async function rebuildLedger(log: string[]) {
  const store = boardStore(); const idx: any = (await settle(store.get('index', { type: 'json' }) as any, null, log, 'index')) || { dates: [] };
  const days: any[] = []; const sysAll = { w: 0, l: 0, p: 0, units: 0, risk: 0 }, plAll = { w: 0, l: 0, p: 0, units: 0, risk: 0 }, mine = { n: 0, w: 0, l: 0, p: 0, units: 0, risk: 0, clvSum: 0, clvN: 0 }; let clvSum = 0, clvN = 0; let last: string | null = null; let season: string | null = null;
  for (const d of idx.dates) {
    const r: any = await settle(store.get(`results/${d}`, { type: 'json' }) as any, null, log, `results ${d}`); if (!r) continue; const s = r.summary;
    days.push({ date: d, w: s.w, l: s.l, p: s.p, pw: s.plays.w, pl: s.plays.l, units: s.units, clv: s.clv, complete: r.complete });
    for (const k of ['w', 'l', 'p', 'units', 'risk'] as const) { (sysAll as any)[k] += s[k]; (plAll as any)[k] += s.plays[k]; }
    if (s.clv != null) { clvSum += s.clv * s.n_clv; clvN += s.n_clv; } if (s.mine) { for (const k of ['n', 'w', 'l', 'p', 'units', 'risk'] as const) (mine as any)[k] += s.mine[k] || 0; if (s.mine.clv != null) { mine.clvSum += s.mine.clv * s.mine.n_clv; mine.clvN += s.mine.n_clv; } } if (r.complete) last = d; if (!season) { const y = +d.slice(0, 4), m = +d.slice(5, 7); const sy = m >= 8 ? y : y - 1; season = `${sy}-${String(sy + 1).slice(2)}`; }
  }
  const ledger = { asof: todayET(), season: season || '', system: { ...sysAll, units: r2(sysAll.units), clv_avg: clvN ? r1(clvSum / clvN) : null, n_clv: clvN }, plays: { ...plAll, units: r2(plAll.units) }, mine: { n: mine.n, w: mine.w, l: mine.l, p: mine.p, units: r2(mine.units), risk: r2(mine.risk), clv_avg: mine.clvN ? r1(mine.clvSum / mine.clvN) : null, n_clv: mine.clvN }, note: days.length ? 'System picks lock at the last pre-game board; results and closing-line value are graded the next morning.' : 'No graded slates yet. Picks lock each morning; results and closing-line value post the next day.', last_graded: last, days: days.reverse() };
  await store.setJSON('ledger', ledger); return ledger;
}
// Grade every past date that has a board but no complete result (up to `back` days), then rebuild the ledger.
export async function gradePending(back = 10, log: string[] = []) {
  const store = boardStore(); const idx: any = (await settle(store.get('index', { type: 'json' }) as any, null, log, 'index')) || { dates: [] }; const today = todayET(); const floor = addDays(today, -back); const done: string[] = [];
  for (const d of idx.dates) { if (d >= today || d < floor) continue; const r: any = await settle(store.get(`results/${d}`, { type: 'json' }) as any, null, log, `results ${d}`); if (r?.complete) continue; const g = await settle(gradeDate(d, log), null, log, `grade ${d}`); if (g) done.push(`${d}:${g.summary.w}-${g.summary.l}${g.complete ? '' : ' (partial)'}`); }
  const ledger = await rebuildLedger(log); console.log(`graded ${done.join(', ') || 'nothing new'}; ledger ${ledger.system.w}-${ledger.system.l}; problems: ${log.join(' | ') || 'none'}`);
  return { done, ledger, problems: log };
}
