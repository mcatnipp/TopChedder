// TopCheddar NHL board engine — JavaScript port of the Python pipeline (sim.py).
// Poisson Monte Carlo with a late-game empty-net model, OT/SO, tie calibration, market EV, line shop and system picks.
// Pure: no I/O. `simulateBoard(input)` → the games.json payload the front end renders.

export type Lines = {
  ml_home?: number | null; ml_away?: number | null; pl_fav?: string | null; pl_odds_fav?: number | null; pl_odds_dog?: number | null;
  total?: number | null; over_odds?: number | null; under_odds?: number | null; p1_total?: number | null; p1_over_odds?: number | null; p1_under_odds?: number | null;
  reg_home_odds?: number | null; reg_draw_odds?: number | null; reg_away_odds?: number | null; tt_home?: { line: number; over: number; under: number } | null; tt_away?: { line: number; over: number; under: number } | null; books_prices?: any[]; open?: string; books?: string;
};
export type GoalieIn = { name?: string; status?: string; gsax_last?: number | null; gp_last?: number | null; sv_pct_last?: number | null; note?: string };
export type GameIn = {
  gid?: number; away: string; home: string; away_abbr: string; home_abbr: string; date: string; puck_et: string; puck_utc?: string; tv?: string; arena?: string;
  records?: [string, string]; lines: Lines; goalies?: { away?: GoalieIn; home?: GoalieIn }; rest?: any; inj?: any[]; news?: string[]; series?: any; spot?: string; note?: string; src?: string[];
};
export type TeamRating = { abbr: string; pts: number; gf: number; ga: number; diff: number };
export type MPTeam = { gp: number; xgf: number; xga: number; gf: number; ga: number; sf: number; sa: number };
export type MPGoalie = { team: string; gp: number; gsax: number };
export type Special = { pp: number; pk: number };
export type BoardInput = {
  date: string; label: string; seed?: number; games: GameIn[]; ratings: TeamRating[];
  league?: { league_avg?: number; ot_rate?: number }; params?: Partial<Params>;
  mp?: { cur_teams?: Record<string, MPTeam>; last_teams?: Record<string, MPTeam>; cur_goalies?: Record<string, MPGoalie>; last_goalies?: Record<string, MPGoalie>; cur_special?: Record<string, Special>; last_special?: Record<string, Special> };
  seasons?: { cur: string; last: string };
};
export type Params = { hfa: number; sv_base: number; shots_against: number; n: number; sig: number; p_ot_goal: number; shrink: number; blend_k: number; xg_weight: number; card_min_gp: number; play_ev: number; en: { window: number; pull1: number; pull2: number; att60: number; en60: number; dt: number } };

const DEF: Params = { hfa: 1.04, sv_base: 0.900, shots_against: 28, n: 30000, sig: 0.08, p_ot_goal: 0.60, shrink: 0.3, blend_k: 20, xg_weight: 0.7, card_min_gp: 10, play_ev: 0.04, en: { window: 3.0, pull1: 1.75, pull2: 3.0, att60: 6.5, en60: 11.0, dt: 1 / 12 } };

// ---------- RNG (sfc32, seeded) ----------
function makeRng(seed: number) {
  let a = 0x9E3779B9 ^ seed, b = 0x243F6A88 ^ (seed * 7919), c = 0xB7E15162 ^ (seed >>> 3), d = seed | 1;
  const next = () => { a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0; let t = (a + b) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0; return (t >>> 0) / 4294967296; };
  for (let i = 0; i < 20; i++) next();
  let spare: number | null = null;
  const normal = () => { if (spare != null) { const s = spare; spare = null; return s; } let u = 0, v = 0; while (u === 0) u = next(); v = next(); const r = Math.sqrt(-2 * Math.log(u)), t = 2 * Math.PI * v; spare = r * Math.sin(t); return r * Math.cos(t); };
  const poisson = (lam: number) => { if (lam <= 0) return 0; if (lam < 30) { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= next(); } while (p > L); return k - 1; } return Math.max(0, Math.round(lam + Math.sqrt(lam) * normal())); };
  return { next, normal, poisson };
}
type Rng = ReturnType<typeof makeRng>;

// ---------- odds helpers ----------
export const imp = (o: number | null | undefined) => o == null ? null : (o < 0 ? -o / (-o + 100) : 100 / (o + 100));
export const novig = (a: number | null | undefined, b: number | null | undefined): [number | null, number | null] => { const pa = imp(a), pb = imp(b); if (pa == null || pb == null) return [null, null]; return [pa / (pa + pb), pb / (pa + pb)]; };
export const payout = (o: number) => o < 0 ? 100 / -o : o / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000, r2 = (x: number) => Math.round(x * 100) / 100, r1 = (x: number) => Math.round(x * 10) / 10;
const mean = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };
const median = (xs: number[]) => { const a = xs.slice().sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

// ---------- late-game empty-net model ----------
// Trailing team pulls ~1:45 left down 1, ~3:00 down 2; 6-on-5 attack ~6.5 GF/60, empty-net goals against ~11/60, scaled by team strength, 5-second steps.
function lateGame(rng: Rng, H: Int16Array, A: Int16Array, lh: Float64Array, la: Float64Array, LG: number, EN: Params['en']) {
  const n = H.length, dt = EN.dt, steps = Math.round(EN.window / dt);
  const enH = new Int16Array(n), enA = new Int16Array(n), pulledD1 = new Uint8Array(n), tiedAfterPull = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let h = H[i], a = A[i]; const sh = lh[i] / LG, sa = la[i] / LG;
    for (let k = 0; k < steps; k++) {
      const tLeft = EN.window - k * dt, m = h - a;
      const pullA = (m === 1 && tLeft <= EN.pull1) || (m === 2 && tLeft <= EN.pull2);
      const pullH = (m === -1 && tLeft <= EN.pull1) || (m === -2 && tLeft <= EN.pull2);
      if ((m === 1 || m === -1) && (pullA || pullH)) pulledD1[i] = 1;
      const rh = (pullH ? EN.att60 * sh : pullA ? EN.en60 * Math.sqrt(sh) : lh[i]) / 60 * dt;
      const ra = (pullA ? EN.att60 * sa : pullH ? EN.en60 * Math.sqrt(sa) : la[i]) / 60 * dt;
      const u = rng.next();
      if (u < rh) { h++; if (pullA) enH[i]++; }
      else if (u < rh + ra) { a++; if (pullH) enA[i]++; }
      if (pulledD1[i] && h === a) tiedAfterPull[i] = 1;
    }
    H[i] = h; A[i] = a;
  }
  return { enH, enA, pulledD1, tiedAfterPull };
}

// Regulation-tie rate the raw model gives an average home team vs an average road team (same machinery as the games).
function refTie(rng: Rng, P: Params, LG: number) {
  const n = Math.min(P.n, 30000), lh = LG * P.hfa, la = LG / P.hfa, main = (20 - P.en.window) / 60;
  const uh = new Float64Array(n), ua = new Float64Array(n);
  for (let i = 0; i < n; i++) { uh[i] = Math.exp(rng.normal() * P.sig); ua[i] = Math.exp(rng.normal() * P.sig); }
  const reg = (bh: number, ba: number) => {
    const H = new Int16Array(n), A = new Int16Array(n), lhv = new Float64Array(n), lav = new Float64Array(n);
    for (let i = 0; i < n; i++) { lhv[i] = bh * uh[i]; lav[i] = ba * ua[i]; H[i] = rng.poisson(lhv[i] * (40 / 60 + main)); A[i] = rng.poisson(lav[i] * (40 / 60 + main)); }
    lateGame(rng, H, A, lhv, lav, LG, P.en); return { H, A };
  };
  const p1 = reg(lh, la);
  const bh = lh * (1 - (mean(p1.H) - lh * mean(uh)) / lh), ba = la * (1 - (mean(p1.A) - la * mean(ua)) / la);
  const p2 = reg(bh, ba); let ties = 0; for (let i = 0; i < n; i++) if (p2.H[i] === p2.A[i]) ties++;
  return ties / n;
}

// ---------- ratings & cards ----------
function buildRatings(inp: BoardInput, P: Params, LG: number) {
  const R: Record<string, any> = {}; const MPT = inp.mp?.cur_teams || {};
  for (const t of inp.ratings) {
    const k = P.shrink, pgf = t.gf * (1 - k) + LG * k, pga = t.ga * (1 - k) + LG * k; const cur = MPT[t.abbr];
    let w = 0, agf: number | null = null, aga: number | null = null, rgf = pgf, rga = pga;
    if (cur && cur.gp > 0) { w = cur.gp / (cur.gp + P.blend_k); agf = P.xg_weight * cur.xgf + (1 - P.xg_weight) * cur.gf; aga = P.xg_weight * cur.xga + (1 - P.xg_weight) * cur.ga; rgf = (1 - w) * pgf + w * agf; rga = (1 - w) * pga + w * aga; }
    R[t.abbr] = { pts: t.pts, gf_raw: t.gf, ga_raw: t.ga, gf: rgf, ga: rga, diff: t.diff, w_actual: r3(w), gp: cur ? Math.round(cur.gp) : 0, act_gf: agf != null ? r2(agf) : null, act_ga: aga != null ? r2(aga) : null, xgf_pg: cur ? r2(cur.xgf) : null, xga_pg: cur ? r2(cur.xga) : null };
  }
  return R;
}
function buildCards(inp: BoardInput, R: Record<string, any>, P: Params) {
  const teams = Object.keys(R), MPT = inp.mp?.cur_teams || {}, MPL = inp.mp?.last_teams || {}, SPC = inp.mp?.cur_special || {}, SPL = inp.mp?.last_special || {};
  const curOk = teams.length > 0 && teams.every(t => (MPT[t]?.gp || 0) >= P.card_min_gp);
  const T = curOk ? MPT : MPL, S = (curOk && Object.keys(SPC).length) ? SPC : SPL; const season = curOk ? (inp.seasons?.cur || 'this season') : (inp.seasons?.last || 'last season');
  const metrics: [string, string, boolean | null, (t: string) => number | null | undefined][] = [
    ['off', 'Offense (model GF/gm)', true, t => R[t].gf], ['def', 'Defense (model GA/gm)', false, t => R[t].ga],
    ['xgf', `xG for / gm (${season})`, true, t => T[t]?.xgf], ['xga', `xG against / gm (${season})`, false, t => T[t]?.xga],
    ['sf', `Shots for / gm (${season})`, true, t => T[t]?.sf], ['sa', `Shots against / gm (${season})`, false, t => T[t]?.sa],
    ['pp', `Power play xG / 60 (${season})`, true, t => S[t]?.pp], ['pk', `Penalty kill xGA / 60 (${season})`, false, t => S[t]?.pk],
    ['pace', `Pace: shots both ways / gm (${season})`, null, t => ((T[t]?.sf || 0) + (T[t]?.sa || 0)) || null]];
  const cards: Record<string, any> = {}; teams.forEach(t => cards[t] = {}); const meta: any[] = [];
  for (const [key, label, hib, get] of metrics) {
    const have: [string, number][] = []; for (const t of teams) { const v = get(t); if (v != null && Number.isFinite(v)) have.push([t, v]); }
    if (have.length < 20) continue; meta.push({ key, label, dir: hib === true ? 'up' : hib === false ? 'down' : 'neutral' }); const n = have.length;
    for (const [t, v] of have) { let better = 0; for (const [, u] of have) if (hib === false ? u > v : u < v) better++; cards[t][key] = { v: r2(v), pct: Math.round(100 * better / (n - 1)) }; }
  }
  return { cards, meta, season };
}
function goalieAdj(gl: GoalieIn | undefined, inp: BoardInput, P: Params): [number, string] {
  if (!gl) return [0, 'unknown']; const nm = (gl.name || '').toLowerCase(); const last = inp.mp?.last_goalies?.[nm], cur = inp.mp?.cur_goalies?.[nm];
  if (last || cur) {
    const lp = last ? last.gsax / (last.gp + 10) : 0;
    if (cur && cur.gp > 0) { const w = cur.gp / (cur.gp + P.blend_k); const pg = (1 - w) * lp + w * cur.gsax / cur.gp; return [0.5 * pg, `MoneyPuck GSAx ${cur.gsax >= 0 ? '+' : ''}${r1(cur.gsax)} in ${cur.gp} GP this season${last ? ` (last season ${last.gsax >= 0 ? '+' : ''}${r1(last.gsax)} in ${last.gp})` : ''} · ${Math.round(w * 100)}% this season`]; }
    return [0.5 * lp, `MoneyPuck GSAx ${last!.gsax >= 0 ? '+' : ''}${r1(last!.gsax)} in ${last!.gp} GP last season`];
  }
  if (gl.gsax_last != null && gl.gp_last) return [0.5 * gl.gsax_last / gl.gp_last, `GSAx ${gl.gsax_last >= 0 ? '+' : ''}${r1(gl.gsax_last)} in ${gl.gp_last} GP`];
  if (gl.sv_pct_last != null) return [0.5 * (gl.sv_pct_last - P.sv_base) * P.shots_against, `SV% ${gl.sv_pct_last.toFixed(3)} (${gl.gp_last || '?'} GP)`];
  return [0, 'no data'];
}
function goalieCard(gl: GoalieIn | undefined, b2b: boolean, inp: BoardInput, P: Params) {
  if (!gl || !gl.name) return null; const nm = gl.name.toLowerCase(); const last = inp.mp?.last_goalies?.[nm], cur = inp.mp?.cur_goalies?.[nm];
  const useCur = !!(cur && cur.gp >= P.card_min_gp); const src = useCur ? (inp.mp?.cur_goalies || {}) : (inp.mp?.last_goalies || {});
  const pool = Object.values(src).filter(g => g.gp >= (useCur ? P.card_min_gp : 20)).map(g => g.gsax / g.gp); const me = useCur ? cur : last; let pct: number | null = null;
  if (me && pool.length) { const r = me.gsax / me.gp; pct = Math.round(100 * pool.filter(q => q < r).length / Math.max(pool.length - 1, 1)); }
  return { name: gl.name, status: gl.status || null, last: last ? { gsax: r1(last.gsax), gp: last.gp, team: last.team } : null, cur: cur ? { gsax: r1(cur.gsax), gp: cur.gp } : null, pct, pool: pool.length, basis: useCur ? (inp.seasons?.cur || 'this season') : (inp.seasons?.last || 'last season'), b2b: !!b2b, sv_last: gl.sv_pct_last ?? null };
}

// ---------- one game ----------
function simGame(x: GameIn, ctx: { rng: Rng; P: Params; LG: number; R: Record<string, any>; TIE_MULT: number; inp: BoardInput; CARDS: any }) {
  const { rng, P, LG, R, inp } = ctx; const N = P.n, a = x.away_abbr, h = x.home_abbr, L = x.lines || {}; const ra = R[a], rh = R[h];
  if (!ra || !rh) throw new Error(`missing rating for ${a} or ${h}`);
  let lamH = LG * (rh.gf / LG) * (ra.ga / LG) * P.hfa, lamA = LG * (ra.gf / LG) * (rh.ga / LG) / P.hfa;
  const [gaA, whyA] = goalieAdj(x.goalies?.away, inp, P), [gaH, whyH] = goalieAdj(x.goalies?.home, inp, P);
  lamH = Math.max(0.8, lamH - gaA); lamA = Math.max(0.8, lamA - gaH);
  const rest = x.rest || {}; if (rest.away_b2b) { lamA *= 0.96; lamH *= 1.04; } if (rest.home_b2b) { lamH *= 0.96; lamA *= 1.04; }
  const uh = new Float64Array(N), ua = new Float64Array(N); for (let i = 0; i < N; i++) { uh[i] = Math.exp(rng.normal() * P.sig); ua[i] = Math.exp(rng.normal() * P.sig); }
  const main = (20 - P.en.window) / 60;
  const regulation = (bh: number, ba: number) => {
    const p1h = new Int16Array(N), p2h = new Int16Array(N), p1a = new Int16Array(N), p2a = new Int16Array(N), H = new Int16Array(N), A = new Int16Array(N), lhv = new Float64Array(N), lav = new Float64Array(N);
    for (let i = 0; i < N; i++) { lhv[i] = bh * uh[i]; lav[i] = ba * ua[i]; p1h[i] = rng.poisson(lhv[i] / 3); p2h[i] = rng.poisson(lhv[i] / 3); p1a[i] = rng.poisson(lav[i] / 3); p2a[i] = rng.poisson(lav[i] / 3); H[i] = p1h[i] + p2h[i] + rng.poisson(lhv[i] * main); A[i] = p1a[i] + p2a[i] + rng.poisson(lav[i] * main); }
    const lg = lateGame(rng, H, A, lhv, lav, LG, P.en); return { p1h, p2h, p1a, p2a, H, A, ...lg };
  };
  // pass 1 measures what the late-game phase adds; pass 2 trims base rates so expected goals stay at lam
  const s1 = regulation(lamH, lamA); const xh = mean(s1.H) - lamH * mean(uh), xa = mean(s1.A) - lamA * mean(ua);
  const bh = lamH * Math.max(0.5, 1 - xh / lamH), ba = lamA * Math.max(0.5, 1 - xa / lamA);
  const s = regulation(bh, ba);
  // OT / SO
  let hw = 0, regH = 0, regD = 0, regA = 0, otHomeN = 0, tieN = 0, enSum = 0, pd1 = 0, tap = 0, p1o15 = 0, p1o05 = 0;
  const histT = new Array(13).fill(0), histM = new Array(11).fill(0), histP1 = new Array(7).fill(0);
  const mArr = new Int16Array(N), tArr = new Int16Array(N), p1Arr = new Int16Array(N), m2Arr = new Int16Array(N), HfArr = new Int16Array(N), AfArr = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    const tie = s.H[i] === s.A[i]; let Hf = s.H[i], Af = s.A[i];
    if (tie) { tieN++; const share = lamH * uh[i] / (lamH * uh[i] + lamA * ua[i]); const homeX = rng.next() < P.p_ot_goal ? rng.next() < share : rng.next() < 0.5; if (homeX) { Hf++; otHomeN++; } else Af++; regD++; }
    else if (s.H[i] > s.A[i]) regH++; else regA++;
    if (Hf > Af) hw++;
    const m = Hf - Af, t = Hf + Af; mArr[i] = m; tArr[i] = t; HfArr[i] = Hf; AfArr[i] = Af; histT[Math.min(t, 12)]++; histM[Math.max(0, Math.min(10, m + 5))]++;
    const p1 = s.p1h[i] + s.p1a[i]; p1Arr[i] = p1; histP1[Math.min(p1, 6)]++; if (p1 > 1.5) p1o15++; if (p1 > 0.5) p1o05++;
    m2Arr[i] = (s.p1h[i] + s.p2h[i]) - (s.p1a[i] + s.p2a[i]);
    enSum += s.enH[i] + s.enA[i]; pd1 += s.pulledD1[i]; tap += s.tiedAfterPull[i];
  }
  const g: any = {
    id: `${a}-${h}`.toLowerCase(), gid: x.gid ?? null, away: x.away, home: x.home, aa: a, ha: h, date: x.date, puck_et: x.puck_et, tv: x.tv ?? null, arena: x.arena ?? null, records: x.records ?? null,
    cards: { away: ctx.CARDS[a] || {}, home: ctx.CARDS[h] || {} }, gcards: { away: goalieCard(x.goalies?.away, !!rest.away_b2b, inp, P), home: goalieCard(x.goalies?.home, !!rest.home_b2b, inp, P) },
    en: { goals_pg: r3(enSum / N), pull_d1: r3(pd1 / N), tie_after_pull: r3(tap / Math.max(pd1, 1)) }, mix: { away: ra.w_actual, home: rh.w_actual },
    lines: L, goalies: x.goalies ?? null, goalie_why: { away: whyA, home: whyH }, goalie_adj: { away: r2(gaA), home: r2(gaH) },
    inj: x.inj || [], news: x.news || [], rest, series: x.series ?? null, spot: x.spot ?? null, note: x.note ?? null, src: x.src || [],
    r_away: ra, r_home: rh, lam_away: r2(lamA), lam_home: r2(lamH),
    home_win: r3(hw / N), reg_home: r3(regH / N), reg_draw: r3(regD / N), reg_away: r3(regA / N), proj_home: r1(lamH), proj_away: r1(lamA), model_total: r2(lamH + lamA),
    hist_total: histT, hist_margin: histM, p1_over_15: r3(p1o15 / N), p1_over_05: r3(p1o05 / N)
  };
  // tie calibration
  const d0 = g.reg_draw, d1 = Math.min(0.40, d0 * ctx.TIE_MULT), k = d0 < 1 ? (1 - d1) / (1 - d0) : 1; const otHome = otHomeN / Math.max(tieN, 1);
  g.reg_draw_raw = d0; g.reg_draw = r3(d1); g.reg_home = r3(g.reg_home * k); g.reg_away = r3(g.reg_away * k); g.home_win_raw = g.home_win; g.home_win = r3(g.reg_home + d1 * otHome); g.ot_home_share = r3(otHome);
  // after two periods, from the market favorite's side
  const favHome = (L.ml_home ?? 0) < (L.ml_away ?? 0); let trail = 0, lead = 0, cb = 0, hold = 0, tied2 = 0;
  for (let i = 0; i < N; i++) { const rm2 = favHome ? m2Arr[i] : -m2Arr[i], rm = favHome ? mArr[i] : -mArr[i]; if (rm2 < 0) { trail++; if (rm > 0) cb++; } else if (rm2 > 0) { lead++; if (rm > 0) hold++; } else tied2++; }
  Object.assign(g, { ref: favHome ? h : a, i2_trail: r3(trail / N), i2_comeback: r3(cb / Math.max(trail, 1)), i2_hold: r3(hold / Math.max(lead, 1)), i2_tied: r3(tied2 / N) });
  // market comparison
  const [mh] = novig(L.ml_home, L.ml_away); g.mkt_home = mh != null ? r3(mh) : null; const opts: any[] = [];
  if (mh != null) for (const [side, p, o] of [[h, g.home_win, L.ml_home!], [a, 1 - g.home_win, L.ml_away!]] as [string, number, number][]) opts.push({ market: 'ml', side, line: null, odds: o, prob: r3(p), ev: r3(p * payout(o) - (1 - p)) });
  if (L.pl_fav && L.pl_odds_fav != null && L.pl_odds_dog != null) {
    const fh = L.pl_fav === h; let c = 0; for (let i = 0; i < N; i++) if ((fh ? mArr[i] : -mArr[i]) >= 2) c++; const pFav = c / N; const dog = fh ? a : h;
    for (const [side, p, o, line] of [[L.pl_fav, pFav, L.pl_odds_fav, -1.5], [dog, 1 - pFav, L.pl_odds_dog, 1.5]] as [string, number, number, number][]) opts.push({ market: 'pl', side, line, odds: o, prob: r3(p), ev: r3(p * payout(o) - (1 - p)) });
    g.pl_fav_cover = r3(pFav);
  }
  if (L.total != null) {
    const tl = L.total; let ov = 0, un = 0; for (let i = 0; i < N; i++) { if (tArr[i] > tl) ov++; else if (tArr[i] < tl) un++; } ov /= N; un /= N; const pu = 1 - ov - un;
    g.over = r3(ov / (ov + un)); g.push_total = r3(pu);
    for (const [side, p, o] of [['Over', ov, L.over_odds ?? -110], ['Under', un, L.under_odds ?? -110]] as [string, number, number][]) opts.push({ market: 'total', side, line: tl, odds: o, prob: r3(p), ev: r3(p * payout(o) - (1 - p - pu)) });
  }
  if (L.p1_total != null) {
    const pl1 = L.p1_total; let o1 = 0, u1 = 0; for (let i = 0; i < N; i++) { if (p1Arr[i] > pl1) o1++; else if (p1Arr[i] < pl1) u1++; } o1 /= N; u1 /= N; const pu1 = 1 - o1 - u1;
    g.p1_line = { total: pl1, over: r3(o1), under: r3(u1), push: r3(pu1) };
    for (const [side, p, o] of [['Over', o1, L.p1_over_odds ?? -110], ['Under', u1, L.p1_under_odds ?? -110]] as [string, number, number][]) opts.push({ market: 'p1', side, line: pl1, odds: o, prob: r3(p), ev: r3(p * payout(o) - (1 - p - pu1)) });
  }
  if (L.reg_home_odds != null && L.reg_draw_odds != null && L.reg_away_odds != null) {
    const imps = [imp(L.reg_home_odds)!, imp(L.reg_draw_odds)!, imp(L.reg_away_odds)!], tot3 = imps[0] + imps[1] + imps[2];
    g.reg3_mkt = { home: r3(imps[0] / tot3), draw: r3(imps[1] / tot3), away: r3(imps[2] / tot3) };
    for (const [side, p, o] of [[h, g.reg_home, L.reg_home_odds], ['Tie', g.reg_draw, L.reg_draw_odds], [a, g.reg_away, L.reg_away_odds]] as [string, number, number][]) opts.push({ market: 'reg3', side, line: null, odds: o, prob: r3(p), ev: r3(p * payout(o) - (1 - p)) });
  }
  for (const [side, tt, arr] of [[h, L.tt_home, HfArr], [a, L.tt_away, AfArr]] as [string, any, Int16Array][]) {
    if (!tt || tt.line == null) continue; let ov = 0, un = 0; for (let i = 0; i < N; i++) { if (arr[i] > tt.line) ov++; else if (arr[i] < tt.line) un++; } ov /= N; un /= N; const pu = 1 - ov - un;
    for (const [dir, p, o] of [['Over', ov, tt.over ?? -110], ['Under', un, tt.under ?? -110]] as [string, number, number][]) opts.push({ market: 'tt', side: `${side} ${dir}`, line: tt.line, odds: o, prob: r3(p), ev: r3(p * payout(o) - (1 - p - pu)) });
  }
  // quarter-Kelly stake (fraction of bankroll) for every priced option; negative EV → 0
  for (const o of opts) { const b = payout(o.odds); o.kelly = r3(Math.max(0, (o.prob * b - (1 - o.prob)) / b) * 0.25); }
  g.hist_p1 = histP1; g.options = opts;
  // line shop
  const bk = (L.books_prices || []).filter((b: any) => b && b.book);
  if (bk.length) {
    const shop: any = {}; const mlb = bk.filter((b: any) => b.ml_home != null && b.ml_away != null);
    if (mlb.length) {
      const sharp = mlb.filter((b: any) => b.sharp); const nv = (sharp.length ? sharp : mlb).map((b: any) => novig(b.ml_home, b.ml_away)[0]!); const fh = median(nv); const src = sharp.length ? sharp[0].book : `median of ${mlb.length} books`;
      const bhB = mlb.reduce((p: any, b: any) => payout(b.ml_home) > payout(p.ml_home) ? b : p), baB = mlb.reduce((p: any, b: any) => payout(b.ml_away) > payout(p.ml_away) ? b : p);
      shop.ml = { fair_home: r3(fh), fair_src: src, n: mlb.length,
        home: { best: bhB.ml_home, book: bhB.book, mkt_ev: r3(fh * payout(bhB.ml_home) - (1 - fh)), model_ev: r3(g.home_win * payout(bhB.ml_home) - (1 - g.home_win)) },
        away: { best: baB.ml_away, book: baB.book, mkt_ev: r3((1 - fh) * payout(baB.ml_away) - fh), model_ev: r3((1 - g.home_win) * payout(baB.ml_away) - g.home_win) } };
    }
    const tl = L.total; const tb = bk.filter((b: any) => b.total === tl && b.over_odds != null && b.under_odds != null);
    if (tl != null && tb.length) {
      const sharp = tb.filter((b: any) => b.sharp); const fo = median((sharp.length ? sharp : tb).map((b: any) => novig(b.over_odds, b.under_odds)[0]!));
      const bo = tb.reduce((p: any, b: any) => payout(b.over_odds) > payout(p.over_odds) ? b : p), bu = tb.reduce((p: any, b: any) => payout(b.under_odds) > payout(p.under_odds) ? b : p); const mo = g.over ?? 0.5;
      shop.total = { line: tl, fair_over: r3(fo), fair_src: sharp.length ? sharp[0].book : `median of ${tb.length} books`, n: tb.length,
        over: { best: bo.over_odds, book: bo.book, mkt_ev: r3(fo * payout(bo.over_odds) - (1 - fo)), model_ev: r3(mo * payout(bo.over_odds) - (1 - mo)) },
        under: { best: bu.under_odds, book: bu.book, mkt_ev: r3((1 - fo) * payout(bu.under_odds) - fo), model_ev: r3((1 - mo) * payout(bu.under_odds) - mo) } };
    }
    g.shop = shop; g.books_prices = bk;
  }
  const best = (mk: string) => opts.filter(o => o.market === mk).reduce((b, o) => !b || o.ev > b.ev ? o : b, null as any);
  const bML = best('ml'), bT = best('total'), bP1 = best('p1'), bR3 = best('reg3'), bTT = best('tt');
  for (const o of [bML, bT, bP1, bR3, bTT]) if (o) o.tier = o.ev >= P.play_ev ? 'play' : 'lean';
  g.sys = { away: a, home: h, away_name: x.away, home_name: x.home, puck: x.puck_et, ml: bML, total: bT, p1: bP1, reg3: bR3, tt: bTT, puck_utc: x.puck_utc || null };
  const notes: string[] = [];
  for (const [side, gl] of [['away', x.goalies?.away], ['home', x.goalies?.home]] as [string, GoalieIn | undefined][]) if (!gl || gl.status !== 'confirmed') notes.push(`${side === 'away' ? a : h} starter not confirmed (${gl?.name || 'unknown'})`);
  if (rest.away_b2b) notes.push(`${a} on a back-to-back`); if (rest.home_b2b) notes.push(`${h} on a back-to-back`);
  if (rest.away_three_in_four) notes.push(`${a} 3rd game in 4 nights`); if (rest.home_three_in_four) notes.push(`${h} 3rd game in 4 nights`);
  if (Math.abs(rest.away_tz || 0) >= 2) notes.push(`${a} crossed ${Math.abs(rest.away_tz)} time zones`); if (Math.abs(rest.home_tz || 0) >= 2) notes.push(`${h} crossed ${Math.abs(rest.home_tz)} time zones`);
  g.notes = notes; g.puck_utc = x.puck_utc || null;
  return g;
}

export function simulateBoard(inp: BoardInput) {
  const P: Params = { ...DEF, ...(inp.params || {}), en: { ...DEF.en, ...((inp.params && inp.params.en) || {}) } };
  const LG = inp.league?.league_avg || 3.15, OT_RATE = inp.league?.ot_rate || 0.248; const seed = inp.seed ?? Number(inp.date.replace(/-/g, ''));
  const rng = makeRng(seed); const REF_TIE = refTie(rng, P, LG); const TIE_MULT = OT_RATE / REF_TIE;
  const R = buildRatings(inp, P, LG); const { cards, meta, season } = buildCards(inp, R, P);
  const ctx = { rng, P, LG, R, TIE_MULT, inp, CARDS: cards }; const games: any[] = [], errors: string[] = [];
  for (const x of inp.games) { try { games.push(simGame(x, ctx)); } catch (e: any) { errors.push(`${x.away_abbr}@${x.home_abbr}: ${e.message}`); } }
  return { games, card_meta: meta, card_season: season, date: inp.date, label: inp.label, errors,
    params: { REF_TIE: r3(REF_TIE), TIE_MULT: r3(TIE_MULT), OT_RATE, EN: P.en, LG, HFA: P.hfa, SV_BASE: P.sv_base, SA: P.shots_against, N: P.n, SIG: P.sig, P_OT: P.p_ot_goal, SEED: seed, PLAY_EV: P.play_ev, BLEND_K: P.blend_k, XG_W: P.xg_weight } };
}
