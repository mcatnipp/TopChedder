// Daily board builder: NHL schedule + standings + MoneyPuck + own odds snapshots → sim → Netlify Blobs (store "board").
// Keys: days/<date> (current board), history/<date>/<ts> (every build, kept), inputs/<date>/<ts> (what went in), index (dates), config/ratings, overrides/<date>.
import { simulateBoard, type GameIn } from './sim.mts';
import { NHL, TEAM_NAMES, getJSON, settle, todayET, puckET, seasonKey, nhlGamesOn, nhlStandings, nhlLanding, nhlBoxscore, goalieLeaders, restContext, mpTeams, mpGoalies, oddsForDate, linesFrom, extraMarkets, notify, boardStore } from './sources.mts';

const str = (v: any) => (v && typeof v === 'object') ? (v.default ?? '') : (v ?? '');
const fmtDate = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export async function loadRatings(log: string[]) {
  const store = boardStore(); const cfg: any = await settle(store.get('config/ratings', { type: 'json' }) as any, null, log, 'config/ratings');
  if (cfg?.teams?.length) return cfg;
  const base = (typeof Netlify !== 'undefined' && Netlify.env.get('URL')) || process.env.URL || 'https://topchedder-scheduler.netlify.app';
  const j: any = await settle(getJSON(`${base}/data/teams.json`), null, log, 'data/teams.json'); if (j?.teams?.length) return j;
  throw new Error('no team ratings available (config/ratings blob or data/teams.json)');
}

export async function buildBoard(opts: { date?: string; n?: number; label?: string } = {}) {
  const t0 = Date.now(); const log: string[] = []; const date = opts.date || todayET(); const store = boardStore(); const now = new Date().toISOString();
  const sk = seasonKey(date);
  const sched: any[] = await nhlGamesOn(date);
  const prev: any = await settle(store.get(`days/${date}`, { type: 'json' }) as any, null, log, 'previous board');
  const [standings, mpCur, mpLast, gCur, gLast, odds, restOf, ratings, overrides] = await Promise.all([
    settle(nhlStandings(), {} as Record<string, any>, log, 'standings'),
    settle(mpTeams(sk.mpYear), { teams: {}, special: {} }, log, `moneypuck teams ${sk.mpYear}`),
    settle(mpTeams(sk.lastMpYear), { teams: {}, special: {} }, log, `moneypuck teams ${sk.lastMpYear}`),
    settle(mpGoalies(sk.mpYear), {} as Record<string, any>, log, `moneypuck goalies ${sk.mpYear}`),
    settle(mpGoalies(sk.lastMpYear), {} as Record<string, any>, log, `moneypuck goalies ${sk.lastMpYear}`),
    oddsForDate(date, log), restContext(date, log), loadRatings(log),
    settle(store.get(`overrides/${date}`, { type: 'json' }) as any, {}, log, 'overrides')
  ]);
  const landings = await Promise.all(sched.map((g: any) => settle(nhlLanding(g.id), null, log, `landing ${g.id}`)));
  const boxes = await Promise.all(sched.map((g: any) => settle(nhlBoxscore(g.id), null, log, `boxscore ${g.id}`)));
  const games: GameIn[] = []; const frozen: any[] = [];
  sched.forEach((g: any, i: number) => {
    const ha = g.homeTeam.abbrev, aa = g.awayTeam.abbrev; const id = `${aa}-${ha}`.toLowerCase(); const land = landings[i], box = boxes[i];
    const started = Date.parse(g.startTimeUTC) <= Date.now() || ['LIVE', 'CRIT', 'OFF', 'FINAL'].includes(g.gameState);
    const old = prev?.games?.find((x: any) => x.id === id);
    if (started && old) { frozen.push({ ...old, frozen: true }); return; } // never re-price a game after puck drop: the last pre-game board is the record
    const ov = ((overrides as any) || {})[id] || {};
    const goalie = (side: 'homeTeam' | 'awayTeam') => {
      const o = ov[side === 'homeTeam' ? 'home' : 'away']; const leaders = goalieLeaders(land, side).sort((a: any, b: any) => b.gp - a.gp);
      const bx = (box?.playerByGameStats?.[side]?.goalies || []).find((x: any) => x.starter); // NHL posts starters in the boxscore once lineups are in
      if (o?.name) return { name: o.name, status: o.status || 'confirmed', sv_pct_last: leaders.find((l: any) => l.name === o.name)?.sv ?? null, gp_last: leaders.find((l: any) => l.name === o.name)?.gp ?? null, note: o.note || 'Set by admin override.' };
      if (bx) { const nm = str(bx.name); const l = leaders.find((x: any) => x.name.endsWith(nm.replace(/^[A-Z]\. /, ''))); return { name: l?.name || nm, status: 'confirmed', sv_pct_last: l?.sv ?? null, gp_last: l?.gp ?? null, note: 'Starter per NHL lineup.' }; }
      const top = leaders[0]; if (!top) return { name: undefined, status: 'unknown', note: 'No goalie data from NHL API.' };
      return { name: top.name, status: 'projected', sv_pct_last: top.sv, gp_last: top.gp, note: `Projected: most starts on the roster (${top.gp} GP${top.record ? ', ' + top.record : ''}${top.sv != null ? ', SV ' + top.sv.toFixed(3).replace(/^0/, '') : ''}). Confirm at morning skate.` };
    };
    const ra = restOf(aa, g.venueUTCOffset), rh = restOf(ha, g.venueUTCOffset);
    const ss = (land?.seasonSeries || []).filter((s: any) => s.gameState === 'OFF' || s.gameState === 'FINAL');
    const series = ss.length ? { last_season: ss.map((s: any) => `${s.gameDate}: ${s.awayTeam?.abbrev} ${s.awayTeam?.score}-${s.homeTeam?.score} ${s.homeTeam?.abbrev}${s.gameOutcome?.lastPeriodType && s.gameOutcome.lastPeriodType !== 'REG' ? ' (' + s.gameOutcome.lastPeriodType + ')' : ''}`).join('; '), note: 'Season series per NHL API.' } : null;
    const sgame = odds.latest?.games?.find((x: any) => x.ha === ha && x.aa === aa);
    const rec = (ab: string) => standings[ab]?.record || land?.[ab === ha ? 'homeTeam' : 'awayTeam']?.record || '0-0-0';
    const spot: string[] = []; if (ra.b2b) spot.push(`${aa} ${ra.note}`); if (rh.b2b) spot.push(`${ha} ${rh.note}`); if (standings[aa]?.streak && /^[WL][3-9]/.test(standings[aa].streak)) spot.push(`${aa} on a ${standings[aa].streak} streak`); if (standings[ha]?.streak && /^[WL][3-9]/.test(standings[ha].streak)) spot.push(`${ha} on a ${standings[ha].streak} streak`);
    games.push({ gid: g.id, away: TEAM_NAMES[aa] || `${str(g.awayTeam.placeName)} ${str(g.awayTeam.commonName)}`.trim(), home: TEAM_NAMES[ha] || `${str(g.homeTeam.placeName)} ${str(g.homeTeam.commonName)}`.trim(), away_abbr: aa, home_abbr: ha, date, puck_et: puckET(g.startTimeUTC), puck_utc: g.startTimeUTC,
      tv: (g.tvBroadcasts || []).map((b: any) => b.network).filter(Boolean).slice(0, 3).join(' / ') || null, arena: str(g.venue) || null, records: [rec(aa), rec(ha)],
      lines: { ...linesFrom(sgame, ha, aa, sgame ? odds.opener[sgame.id] : null), _event: sgame?.id || null }, goalies: { away: goalie('awayTeam'), home: goalie('homeTeam') },
      rest: { away_b2b: ra.b2b, home_b2b: rh.b2b, away_days: ra.days, home_days: rh.days, away_three_in_four: ra.three_in_four, home_three_in_four: rh.three_in_four, away_four_in_six: ra.four_in_six, home_four_in_six: rh.four_in_six, away_tz: ra.tz_shift, home_tz: rh.tz_shift, away_games_7d: ra.games_7d, home_games_7d: rh.games_7d, away_travel: [ra.note && `${aa}: ${ra.note}`, rh.note && `${ha}: ${rh.note}`].filter(Boolean).join(' | ') || null },
      inj: [], news: [], series, spot: spot.join('. ') || null, note: null, src: [`${NHL}/gamecenter/${g.id}/landing`] });
  });
  const oddsKey = (typeof Netlify !== 'undefined' && Netlify.env.get('ODDS_API_KEY')) || process.env.ODDS_API_KEY; const extraOn = ((typeof Netlify !== 'undefined' && Netlify.env.get('ODDS_EXTRA_MARKETS')) || process.env.ODDS_EXTRA_MARKETS || 'on') !== 'off';
  if (oddsKey && extraOn) await Promise.all(games.map(async gm => { const ev = (gm.lines as any)._event; if (!ev) return; const x = await extraMarkets(ev, oddsKey, gm.home_abbr, gm.away_abbr, gm.home, gm.away, log); Object.assign(gm.lines, x); }));
  games.forEach(gm => { delete (gm.lines as any)._event; });
  const ratingsList = ratings.teams.map((t: any) => ({ abbr: t.abbr, pts: t.pts, gf: t.gf, ga: t.ga, diff: t.diff }));
  const out: any = simulateBoard({ date, label: opts.label || `${fmtDate(date)} · ${games.length + frozen.length} games`, games, ratings: ratingsList, league: { league_avg: ratings.league_avg || 3.15, ot_rate: ratings.ot_rate || 0.248 },
    mp: { cur_teams: mpCur.teams, last_teams: mpLast.teams, cur_goalies: gCur, last_goalies: gLast, cur_special: mpCur.special, last_special: mpLast.special }, seasons: { cur: sk.label, last: sk.lastLabel }, params: { n: opts.n || 25000 } });
  out.games = [...frozen, ...out.games].sort((a, b) => Date.parse(a.puck_utc || 0) - Date.parse(b.puck_utc || 0));
  // starter-flip log: any goalie name/status change vs the previous build, with the market at that moment (research: does the market move after a confirmation?)
  const events: any[] = [];
  for (const g of out.games) { const old = prev?.games?.find((x: any) => x.id === g.id); if (!old || g.frozen) continue;
    for (const side of ['away', 'home']) { const a = old.goalies?.[side] || {}, b = g.goalies?.[side] || {}; if (a.name !== b.name || a.status !== b.status) events.push({ at: now, game: g.id, side, team: side === 'away' ? g.aa : g.ha, from: { name: a.name || null, status: a.status || null }, to: { name: b.name || null, status: b.status || null }, market_before: { ml_home: old.lines?.ml_home ?? null, ml_away: old.lines?.ml_away ?? null, total: old.lines?.total ?? null, at: old.lines?.snapshot_at || null }, market_now: { ml_home: g.lines?.ml_home ?? null, ml_away: g.lines?.ml_away ?? null, total: g.lines?.total ?? null, at: g.lines?.snapshot_at || null }, model_before: { home_win: old.home_win, total: old.model_total }, model_now: { home_win: g.home_win, total: g.model_total } }); }
  }
  if (events.length) { const cur: any[] = (await settle(store.get(`starters/${date}`, { type: 'json' }) as any, [], log, 'starters')) || []; await store.setJSON(`starters/${date}`, [...cur, ...events]); }
  // alerts (ntfy): new plays and goalie flips since the last build
  const playsOf = (b: any) => (b?.games || []).flatMap((g: any) => ['ml', 'total', 'p1', 'reg3', 'tt'].map(k => g.sys?.[k]).filter((o: any) => o && o.tier === 'play').map((o: any) => `${g.aa}@${g.ha} ${o.side}${o.line != null ? ' ' + o.line : ''} ${o.odds > 0 ? '+' : ''}${o.odds} (EV ${(o.ev * 100).toFixed(1)}%)`));
  const before = new Set(playsOf(prev)), nowPlays = playsOf(out).filter(p => !before.has(p)); const flips = events.filter(e => e.to.status === 'confirmed' && e.from.status !== 'confirmed').map(e => `${e.team}: ${e.to.name} confirmed`);
  if (nowPlays.length || flips.length) await notify(`TopCheddar ${date}: ${nowPlays.length} new play${nowPlays.length === 1 ? '' : 's'}${flips.length ? `, ${flips.length} goalie confirm` : ''}`, [...nowPlays, ...flips].join('\n'), log);
  out.starter_events = events.length; out.built_at = now; out.sources = { odds_at: odds.latest?.at || null, odds_games: odds.latest?.games?.length || 0, mp_cur_teams: Object.keys(mpCur.teams).length, mp_last_teams: Object.keys(mpLast.teams).length, standings: Object.keys(standings).length, ratings: ratings.source || 'data/teams.json', problems: log };
  out.update = odds.latest ? null : { at: now.slice(11, 16) + ' UTC', text: 'No odds snapshot available yet — market columns are empty until ODDS_API_KEY is set and the first snapshot runs.' };
  out.ms = Date.now() - t0;
  const ts = now.replace(/[:.]/g, '-');
  await store.setJSON(`days/${date}`, out);
  await store.setJSON(`history/${date}/${ts}`, out);
  await store.setJSON(`inputs/${date}/${ts}`, { date, at: now, ratings: ratingsList, league_avg: ratings.league_avg, mp_cur: mpCur, mp_last_summary: Object.keys(mpLast.teams).length, goalies_cur: gCur, standings, lines: Object.fromEntries(games.map(g => [`${g.away_abbr}-${g.home_abbr}`.toLowerCase(), g.lines])), goalies: Object.fromEntries(games.map(g => [`${g.away_abbr}-${g.home_abbr}`.toLowerCase(), g.goalies])), overrides, problems: log });
  const idx: any = (await settle(store.get('index', { type: 'json' }) as any, null, log, 'index')) || { dates: [], built: {} };
  if (!idx.dates.includes(date)) idx.dates.push(date); idx.dates.sort(); idx.built[date] = { at: now, games: out.games.length, ms: out.ms }; await store.setJSON('index', idx);
  console.log(`board ${date}: ${out.games.length} games (${frozen.length} frozen) in ${out.ms} ms; problems: ${log.length ? log.join(' | ') : 'none'}`);
  return out;
}
