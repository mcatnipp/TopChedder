// External data sources for the self-running pipeline. Every fetch is defensive: a failed source degrades the board, never kills it.
// NHL API (api-web.nhle.com), MoneyPuck season CSVs, Google News RSS, and the site's own odds snapshots in Netlify Blobs.
import { getStore } from '@netlify/blobs';

export const NHL = 'https://api-web.nhle.com/v1';
export const ET = 'America/New_York';
export const TEAM_NAMES: Record<string, string> = { ANA: 'Anaheim Ducks', BOS: 'Boston Bruins', BUF: 'Buffalo Sabres', CAR: 'Carolina Hurricanes', CBJ: 'Columbus Blue Jackets', CGY: 'Calgary Flames', CHI: 'Chicago Blackhawks', COL: 'Colorado Avalanche', DAL: 'Dallas Stars', DET: 'Detroit Red Wings', EDM: 'Edmonton Oilers', FLA: 'Florida Panthers', LAK: 'Los Angeles Kings', MIN: 'Minnesota Wild', MTL: 'Montreal Canadiens', NJD: 'New Jersey Devils', NSH: 'Nashville Predators', NYI: 'New York Islanders', NYR: 'New York Rangers', OTT: 'Ottawa Senators', PHI: 'Philadelphia Flyers', PIT: 'Pittsburgh Penguins', SEA: 'Seattle Kraken', SJS: 'San Jose Sharks', STL: 'St. Louis Blues', TBL: 'Tampa Bay Lightning', TOR: 'Toronto Maple Leafs', UTA: 'Utah Mammoth', VAN: 'Vancouver Canucks', VGK: 'Vegas Golden Knights', WPG: 'Winnipeg Jets', WSH: 'Washington Capitals' };

export async function getJSON(url: string, ms = 12000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'topcheddar-board/2.2 (+https://topchedder.com)' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json();
}
export async function getText(url: string, ms = 15000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'topcheddar-board/2.2 (+https://topchedder.com)' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`); return r.text();
}
export const settle = async <T>(p: Promise<T>, fallback: T, log: string[], label: string): Promise<T> => { try { return await p; } catch (e: any) { log.push(`${label}: ${e.message || e}`); return fallback; } };

// ---------- dates ----------
export const todayET = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: ET }).format(d);
export const addDays = (ymd: string, n: number) => { const [y, m, d] = ymd.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n, 12)); return t.toISOString().slice(0, 10); };
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
export function puckET(utc: string) { // "7:00" style, ET
  const d = new Date(utc); const p = new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d);
  const h = p.find(x => x.type === 'hour')?.value || '7', m = p.find(x => x.type === 'minute')?.value || '00'; return `${h}:${m}`;
}
export const fmtET = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: ET, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
export const seasonKey = (ymd: string) => { const y = +ymd.slice(0, 4), m = +ymd.slice(5, 7); const s = m >= 8 ? y : y - 1; return { key: `${s}${s + 1}`, mpYear: s, label: `${s}-${String(s + 1).slice(2)}`, lastMpYear: s - 1, lastLabel: `${s - 1}-${String(s).slice(2)}` }; };

// ---------- NHL API ----------
const str = (v: any) => (v && typeof v === 'object') ? (v.default ?? '') : (v ?? '');
export async function nhlSchedule(date: string) { const j = await getJSON(`${NHL}/schedule/${date}`); return (j.gameWeek || []).flatMap((w: any) => (w.games || []).map((g: any) => ({ ...g, gameDate: w.date }))); }
export async function nhlGamesOn(date: string, types = [2, 3]) { const all = await nhlSchedule(date); return all.filter((g: any) => g.gameDate === date && types.includes(g.gameType)); }
export async function nhlStandings() {
  const j = await getJSON(`${NHL}/standings/now`); const out: Record<string, any> = {};
  for (const t of j.standings || []) { const ab = str(t.teamAbbrev); out[ab] = { gp: t.gamesPlayed, w: t.wins, l: t.losses, otl: t.otLosses, pts: t.points, gf: t.goalFor, ga: t.goalAgainst, l10: `${t.l10Wins}-${t.l10Losses}-${t.l10OtLosses}`, streak: `${t.streakCode || ''}${t.streakCount || ''}`, record: `${t.wins}-${t.losses}-${t.otLosses}` }; }
  return out;
}
export const nhlLanding = (id: number) => getJSON(`${NHL}/gamecenter/${id}/landing`);
export const nhlBoxscore = (id: number) => getJSON(`${NHL}/gamecenter/${id}/boxscore`);
export const nhlPlayByPlay = (id: number) => getJSON(`${NHL}/gamecenter/${id}/play-by-play`, 15000);
export function goalieLeaders(landing: any, side: 'homeTeam' | 'awayTeam') {
  const L = landing?.matchup?.goalieComparison?.[side]?.leaders || [];
  return L.map((g: any) => ({ id: g.playerId, name: `${str(g.firstName)} ${str(g.lastName)}`.trim() || str(g.name), gp: g.gamesPlayed || 0, sv: g.savePctg ?? null, gaa: g.gaa ?? null, record: g.record || null }));
}
// Rest context for every team on a slate: last game, back-to-back, 3-in-4, 4-in-6, time-zone shift since last game, week load.
const offMin = (o: string | undefined) => { const m = String(o || '-05:00').match(/([+-])(\d{2}):(\d{2})/); return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : -300; };
export async function restContext(date: string, log: string[]) {
  const prev = await settle(nhlSchedule(addDays(date, -7)), [], log, 'schedule(prev week)');
  const hist: Record<string, { date: string; venue: string; home: boolean; off: number }[]> = {};
  for (const g of prev.filter((g: any) => g.gameDate < date && [1, 2, 3].includes(g.gameType)).sort((a: any, b: any) => a.gameDate.localeCompare(b.gameDate))) {
    for (const side of ['homeTeam', 'awayTeam']) { const ab = g[side]?.abbrev; if (ab) (hist[ab] = hist[ab] || []).push({ date: g.gameDate, venue: str(g.venue), home: side === 'homeTeam', off: offMin(g.venueUTCOffset) }); }
  }
  return (ab: string, todayOff?: string) => {
    const h = hist[ab] || []; const l = h[h.length - 1];
    if (!l) return { b2b: false, days: null as number | null, three_in_four: false, four_in_six: false, tz_shift: 0, games_7d: 0, note: '' };
    const days = daysBetween(l.date, date); const within = (n: number) => h.filter(x => daysBetween(x.date, date) <= n).length;
    const tz = todayOff != null ? Math.round((offMin(todayOff) - l.off) / 60) : 0;
    const flags: string[] = []; if (days === 1) flags.push(`played ${l.home ? 'at home' : 'on the road'} yesterday (${l.venue})`); else flags.push(`${days} days since last game`);
    if (within(3) >= 2) flags.push('3rd game in 4 nights'); if (within(5) >= 3) flags.push('4th game in 6 nights'); if (Math.abs(tz) >= 2) flags.push(`${Math.abs(tz)} time zones ${tz > 0 ? 'east' : 'west'} since last game`);
    return { b2b: days === 1, days, three_in_four: within(3) >= 2, four_in_six: within(5) >= 3, tz_shift: tz, games_7d: within(7), note: flags.join(', ') };
  };
}

// ---------- MoneyPuck ----------
function parseCSV(text: string) {
  const lines = text.trim().split(/\r?\n/); const head = lines[0].split(','); const idx: Record<string, number> = {}; head.forEach((h, i) => { if (!(h in idx)) idx[h] = i; });
  return { idx, rows: lines.slice(1).map(l => l.split(',')) };
}
export async function mpTeams(year: number) {
  const { idx, rows } = parseCSV(await getText(`https://moneypuck.com/moneypuck/playerData/seasonSummary/${year}/regular/teams.csv`));
  const teams: Record<string, any> = {}, special: Record<string, any> = {}; const raw: Record<string, any> = {};
  const n = (r: string[], k: string) => Number(r[idx[k]]);
  for (const r of rows) {
    const ab = r[idx.team], sit = r[idx.situation], gp = n(r, 'games_played'); if (!ab || !gp) continue; raw[ab] = raw[ab] || {};
    if (sit === 'all') teams[ab] = { gp, xgf: n(r, 'xGoalsFor') / gp, xga: n(r, 'xGoalsAgainst') / gp, gf: n(r, 'goalsFor') / gp, ga: n(r, 'goalsAgainst') / gp, sf: n(r, 'shotsOnGoalFor') / gp, sa: n(r, 'shotsOnGoalAgainst') / gp };
    if (sit === '5on4') raw[ab].pp = { x: n(r, 'xGoalsFor'), t: n(r, 'iceTime') };
    if (sit === '4on5') raw[ab].pk = { x: n(r, 'xGoalsAgainst'), t: n(r, 'iceTime') };
  }
  for (const ab in raw) { const p = raw[ab].pp, k = raw[ab].pk; if (p?.t > 0 && k?.t > 0) special[ab] = { pp: p.x / p.t * 3600, pk: k.x / k.t * 3600 }; }
  return { teams, special };
}
export async function mpGoalies(year: number) {
  const { idx, rows } = parseCSV(await getText(`https://moneypuck.com/moneypuck/playerData/seasonSummary/${year}/regular/goalies.csv`));
  const out: Record<string, any> = {};
  for (const r of rows) { if (r[idx.situation] !== 'all') continue; const gp = Number(r[idx.games_played]); if (!gp) continue; out[String(r[idx.name]).toLowerCase()] = { team: r[idx.team], gp, gsax: Number(r[idx.xGoals]) - Number(r[idx.goals]), name: r[idx.name] }; }
  return out;
}

// ---------- odds (own snapshots in Blobs) ----------
export const oddsStore = () => getStore({ name: 'odds', consistency: 'strong' });
export const boardStore = () => getStore({ name: 'board', consistency: 'strong' });
const median = (xs: number[]) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const mode = (xs: number[]) => { const c: Record<string, number> = {}; xs.filter(Number.isFinite).forEach(x => c[x] = (c[x] || 0) + 1); let b: number | null = null, n = 0; for (const k in c) if (c[k] > n) { n = c[k]; b = Number(k); } return b; };
const SHARP = new Set(['pinnacle', 'circasports', 'circa', 'lowvig', 'betonlineag']);
// Turn one snapshot game into the `lines` object the sim expects.
export function linesFrom(sg: any, ha: string, aa: string, opened?: any): any {
  if (!sg) return {};
  const books = sg.books || []; const plh = mode(books.map((b: any) => b.pl_home));
  let pl: any = {};
  if (plh != null) { const at = books.filter((b: any) => b.pl_home === plh); const favHome = plh < 0; pl = { pl_fav: favHome ? ha : aa, pl_odds_fav: median(at.map((b: any) => favHome ? b.pl_home_odds : b.pl_away_odds)), pl_odds_dog: median(at.map((b: any) => favHome ? b.pl_away_odds : b.pl_home_odds)) }; }
  const books_prices = books.map((b: any) => ({ book: b.title || b.key, key: b.key, sharp: SHARP.has(b.key), ml_home: b.ml_home ?? null, ml_away: b.ml_away ?? null, pl_home: b.pl_home ?? null, pl_home_odds: b.pl_home_odds ?? null, pl_away_odds: b.pl_away_odds ?? null, total: b.total ?? null, over_odds: b.over ?? null, under_odds: b.under ?? null }));
  const fo = (o: number | null) => o == null ? '—' : (o > 0 ? '+' + o : String(o));
  const open = opened ? `Opened ${fmtET(opened.at)}: ${aa} ${fo(opened.cons.ml_away)} / ${ha} ${fo(opened.cons.ml_home)}, total ${opened.cons.total ?? '—'}.` : '';
  return { ml_home: sg.cons.ml_home ?? null, ml_away: sg.cons.ml_away ?? null, ...pl, total: sg.cons.total ?? null, over_odds: sg.cons.over ?? null, under_odds: sg.cons.under ?? null, p1_total: null, books_prices, books: `Consensus of ${books.length} books as of ${fmtET(sg.at || new Date().toISOString())}`, open, snapshot_at: sg.at || null };
}
// Latest snapshot plus the first snapshot that listed each game today (the "opener").
export async function oddsForDate(date: string, log: string[]) {
  const store = oddsStore(); const latest: any = await settle(store.get('latest', { type: 'json' }) as any, null, log, 'odds latest');
  if (!latest) return { latest: null, opener: {} as Record<string, any> };
  const idx: string[] = (await settle(store.get('index', { type: 'json' }) as any, [], log, 'odds index')) || [];
  const dayStart = Date.parse(date + 'T04:00:00-04:00') - 12 * 3600e3; // include the previous evening's snapshots
  const opener: Record<string, any> = {};
  for (const at of idx.filter(t => Date.parse(t) >= dayStart).slice(0, 8)) { // first few snapshots of the day are enough to find openers
    const s: any = await settle(store.get(`snap/${at.replace(/[:.]/g, '-')}`, { type: 'json' }) as any, null, log, 'odds snap'); if (!s) continue;
    for (const g of s.games || []) if (!opener[g.id]) opener[g.id] = { at: s.at, cons: g.cons };
  }
  latest.games.forEach((g: any) => g.at = latest.at);
  return { latest, opener };
}
// Extra markets for one event (event-odds endpoint): regulation 3-way, 1st-period total, team totals. Cost = markets × regions per event.
export async function extraMarkets(eventId: string, key: string, ha: string, aa: string, homeName: string, awayName: string, log: string[]) {
  const url = `https://api.the-odds-api.com/v4/sports/icehockey_nhl/events/${eventId}/odds?regions=us&markets=h2h_3_way,totals_p1,team_totals&oddsFormat=american&dateFormat=iso&apiKey=${key}`;
  const ev: any = await settle(getJSON(url, 10000), null, log, `extra markets ${aa}@${ha}`); if (!ev) return {};
  const med = (xs: number[]) => median(xs); const acc: Record<string, number[]> = {}; const push = (k: string, v: any) => { if (Number.isFinite(v)) (acc[k] = acc[k] || []).push(v); };
  const p1lines: number[] = [], tth: number[] = [], tta: number[] = [];
  for (const bk of ev.bookmakers || []) for (const m of bk.markets || []) for (const o of m.outcomes || []) {
    if (m.key === 'h2h_3_way') { if (o.name === homeName) push('reg_home', o.price); else if (o.name === awayName) push('reg_away', o.price); else if (/draw|tie/i.test(o.name)) push('reg_draw', o.price); }
    if (m.key === 'totals_p1') { p1lines.push(o.point); push(`p1_${o.name}_${o.point}`, o.price); }
    if (m.key === 'team_totals') { const home = o.description === homeName; (home ? tth : tta).push(o.point); push(`tt_${home ? 'h' : 'a'}_${o.name}_${o.point}`, o.price); }
  }
  const out: any = {};
  if (acc.reg_home && acc.reg_draw && acc.reg_away) { out.reg_home_odds = med(acc.reg_home); out.reg_draw_odds = med(acc.reg_draw); out.reg_away_odds = med(acc.reg_away); }
  const p1 = mode(p1lines); if (p1 != null && acc[`p1_Over_${p1}`] && acc[`p1_Under_${p1}`]) { out.p1_total = p1; out.p1_over_odds = med(acc[`p1_Over_${p1}`]); out.p1_under_odds = med(acc[`p1_Under_${p1}`]); }
  const th = mode(tth); if (th != null && acc[`tt_h_Over_${th}`] && acc[`tt_h_Under_${th}`]) out.tt_home = { line: th, over: med(acc[`tt_h_Over_${th}`]), under: med(acc[`tt_h_Under_${th}`]) };
  const ta = mode(tta); if (ta != null && acc[`tt_a_Over_${ta}`] && acc[`tt_a_Under_${ta}`]) out.tt_away = { line: ta, over: med(acc[`tt_a_Over_${ta}`]), under: med(acc[`tt_a_Under_${ta}`]) };
  out.extra_at = new Date().toISOString(); out.extra_books = (ev.bookmakers || []).length; return out;
}
// Push notification via ntfy.sh (free, no account: install the ntfy app and subscribe to the topic in NTFY_TOPIC).
export async function notify(title: string, body: string, log: string[], tags = 'hockey') {
  const topic = (typeof Netlify !== 'undefined' && Netlify.env.get('NTFY_TOPIC')) || process.env.NTFY_TOPIC; if (!topic) return false;
  try { const r = await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body, headers: { Title: title, Tags: tags, Priority: '4' }, signal: AbortSignal.timeout(8000) }); return r.ok; } catch (e: any) { log.push(`ntfy: ${e.message}`); return false; }
}
// Closing lines: the last snapshot taken before puck drop for a game.
export async function closingFor(gameKey: (g: any) => boolean, puckUtc: string, log: string[]) {
  const store = oddsStore(); const idx: string[] = (await settle(store.get('index', { type: 'json' }) as any, [], log, 'odds index')) || [];
  const t = Date.parse(puckUtc); const before = idx.filter(x => Date.parse(x) <= t).slice(-3).reverse();
  for (const at of before) { const s: any = await settle(store.get(`snap/${at.replace(/[:.]/g, '-')}`, { type: 'json' }) as any, null, log, 'odds snap'); const g = s?.games?.find(gameKey); if (g) return { at: s.at, ...g }; }
  return null;
}

// ---------- news (RSS) ----------
function decode(s: string) { return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/<[^>]+>/g, '').trim(); }
export function parseFeed(xml: string, source: string) {
  const items: any[] = []; const tag = (s: string, t: string) => { const m = s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]) : ''; };
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) { const s = m[0]; const link = tag(s, 'link') || (s.match(/<link[^>]*href="([^"]+)"/) || [])[1] || ''; items.push({ title: tag(s, 'title'), link, at: new Date(tag(s, 'pubDate') || tag(s, 'dc:date') || Date.now()).toISOString(), source: tag(s, 'source') || source }); }
  if (!items.length) for (const m of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/g)) { const s = m[0]; items.push({ title: tag(s, 'title'), link: (s.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '', at: new Date(tag(s, 'updated') || tag(s, 'published') || Date.now()).toISOString(), source }); }
  return items.filter(i => i.title);
}
export const googleNewsRSS = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
export const LEAGUE_FEEDS = [
  { url: googleNewsRSS('NHL when:1d'), source: 'Google News · NHL' },
  { url: googleNewsRSS('NHL starting goalies OR "goalie" OR "injury" when:1d'), source: 'Google News · goalies & injuries' },
  { url: 'https://www.nhl.com/rss/news', source: 'NHL.com' },
  { url: 'https://www.espn.com/espn/rss/nhl/news', source: 'ESPN' },
  { url: 'https://www.sportsnet.ca/hockey/nhl/feed/', source: 'Sportsnet' },
  { url: 'https://www.dailyfaceoff.com/feed/', source: 'Daily Faceoff' }
];
