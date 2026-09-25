// Shared odds helpers: normalise an Odds API payload into a compact snapshot, and diff snapshots into "moves".
const ABBR: Record<string, string> = {
  'Anaheim Ducks':'ANA','Boston Bruins':'BOS','Buffalo Sabres':'BUF','Carolina Hurricanes':'CAR','Columbus Blue Jackets':'CBJ','Calgary Flames':'CGY','Chicago Blackhawks':'CHI','Colorado Avalanche':'COL','Dallas Stars':'DAL','Detroit Red Wings':'DET','Edmonton Oilers':'EDM','Florida Panthers':'FLA','Los Angeles Kings':'LAK','Minnesota Wild':'MIN','Montréal Canadiens':'MTL','Montreal Canadiens':'MTL','New Jersey Devils':'NJD','Nashville Predators':'NSH','New York Islanders':'NYI','New York Rangers':'NYR','Ottawa Senators':'OTT','Philadelphia Flyers':'PHI','Pittsburgh Penguins':'PIT','Seattle Kraken':'SEA','San Jose Sharks':'SJS','St Louis Blues':'STL','St. Louis Blues':'STL','Tampa Bay Lightning':'TBL','Toronto Maple Leafs':'TOR','Utah Mammoth':'UTA','Utah Hockey Club':'UTA','Vancouver Canucks':'VAN','Vegas Golden Knights':'VGK','Winnipeg Jets':'WPG','Washington Capitals':'WSH'
};
export const abbr = (name: string) => ABBR[name] || (name || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 3);
const imp = (o: number) => o < 0 ? -o / (-o + 100) : 100 / (o + 100);
const median = (xs: number[]) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const mode = (xs: number[]) => { const c: Record<string, number> = {}; xs.filter(Number.isFinite).forEach(x => c[x] = (c[x] || 0) + 1); let b: number | null = null, n = 0; Object.entries(c).forEach(([k, v]) => { if (v > n) { n = v; b = Number(k); } }); return b; };

export function buildSnapshot(events: any[], credits?: any) {
  const at = new Date().toISOString();
  const games = (Array.isArray(events) ? events : []).map(ev => {
    const home = ev.home_team, away = ev.away_team;
    const books = (ev.bookmakers || []).map((bk: any) => {
      const b: any = { key: bk.key, title: bk.title, at: bk.last_update };
      for (const m of bk.markets || []) {
        if (m.key === 'h2h') { for (const o of m.outcomes || []) { if (o.name === home) b.ml_home = o.price; else if (o.name === away) b.ml_away = o.price; } }
        if (m.key === 'spreads') { for (const o of m.outcomes || []) { if (o.name === home) { b.pl_home = o.point; b.pl_home_odds = o.price; } else if (o.name === away) { b.pl_away = o.point; b.pl_away_odds = o.price; } } }
        if (m.key === 'totals') { for (const o of m.outcomes || []) { if (o.name === 'Over') { b.total = o.point; b.over = o.price; } else if (o.name === 'Under') { b.under = o.price; } } }
      }
      return b;
    });
    const mlh = median(books.map((b: any) => b.ml_home)), mla = median(books.map((b: any) => b.ml_away));
    const total = mode(books.map((b: any) => b.total));
    const atLine = books.filter((b: any) => b.total === total);
    const over = median(atLine.map((b: any) => b.over)), under = median(atLine.map((b: any) => b.under));
    let fair_home: number | null = null; if (mlh != null && mla != null) { const ih = imp(mlh), ia = imp(mla); fair_home = ih / (ih + ia); }
    const best: any = {
      ml_home: Math.max(...books.map((b: any) => b.ml_home).filter(Number.isFinite), -Infinity), ml_away: Math.max(...books.map((b: any) => b.ml_away).filter(Number.isFinite), -Infinity),
      over: Math.max(...atLine.map((b: any) => b.over).filter(Number.isFinite), -Infinity), under: Math.max(...atLine.map((b: any) => b.under).filter(Number.isFinite), -Infinity)
    };
    for (const k in best) if (!Number.isFinite(best[k])) best[k] = null;
    return { id: ev.id, home, away, ha: abbr(home), aa: abbr(away), commence: ev.commence_time, books, cons: { ml_home: mlh, ml_away: mla, fair_home, total, over, under }, best };
  });
  return { at, games, credits: credits || null };
}

const fmtOdds = (o: number | null) => o == null ? '—' : (o > 0 ? '+' + o : String(o));
// Diff a series of snapshots (oldest → newest) into consensus moves per game.
export function movesFor(snaps: any[]) {
  if (!snaps.length) return {};
  const latest = snaps[snaps.length - 1];
  const out: Record<string, any[]> = {};
  for (const g of latest.games) {
    const series = snaps.map(s => ({ at: s.at, g: (s.games || []).find((x: any) => x.id === g.id) })).filter(x => x.g);
    if (series.length < 2) { out[g.id] = []; continue; }
    const first = series[0], moves: any[] = [];
    // moneyline: report when fair win% moved ≥ 2 pts from first snapshot, quoting consensus home price
    if (first.g.cons.fair_home != null && g.cons.fair_home != null) {
      const d = g.cons.fair_home - first.g.cons.fair_home;
      if (Math.abs(d) >= 0.02) moves.push({ market: `${g.ha} moneyline`, label: d > 0 ? `${g.ha} ↑` : `${g.aa} ↑`, dir: d > 0 ? 'up' : 'dn', from: fmtOdds(first.g.cons.ml_home), to: fmtOdds(g.cons.ml_home), at: lastChangeAt(series, x => x.g.cons.ml_home) });
    }
    if (first.g.cons.total != null && g.cons.total != null && first.g.cons.total !== g.cons.total) {
      moves.push({ market: 'total', label: g.cons.total > first.g.cons.total ? 'Total ↑' : 'Total ↓', dir: g.cons.total > first.g.cons.total ? 'up' : 'dn', from: String(first.g.cons.total), to: String(g.cons.total), at: lastChangeAt(series, x => x.g.cons.total) });
    } else if (first.g.cons.over != null && g.cons.over != null && Math.abs(imp(g.cons.over) - imp(first.g.cons.over)) >= 0.025) {
      const d = imp(g.cons.over) - imp(first.g.cons.over);
      moves.push({ market: `total ${g.cons.total} juice`, label: d > 0 ? 'Over ↑' : 'Under ↑', dir: d > 0 ? 'up' : 'dn', from: `o${fmtOdds(first.g.cons.over)}`, to: `o${fmtOdds(g.cons.over)}`, at: lastChangeAt(series, x => x.g.cons.over) });
    }
    out[g.id] = moves;
  }
  return out;
}
function lastChangeAt(series: any[], pick: (x: any) => any) { let at = series[series.length - 1].at; for (let i = series.length - 1; i > 0; i--) { if (pick(series[i]) !== pick(series[i - 1])) { at = series[i].at; break; } } return at; }
