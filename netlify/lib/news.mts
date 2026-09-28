// Hourly news: real RSS feeds (Google News per team on today's slate + league feeds), deduped, kept per day. Keys: news/latest, news/<date>.
import { getText, settle, todayET, parseFeed, googleNewsRSS, LEAGUE_FEEDS, TEAM_NAMES, nhlGamesOn, boardStore } from './sources.mts';

export async function refreshNews(date = todayET()) {
  const log: string[] = []; const store = boardStore();
  const board: any = await settle(store.get(`days/${date}`, { type: 'json' }) as any, null, log, 'board');
  let teams: string[] = board ? Array.from(new Set((board.games || []).flatMap((g: any) => [g.aa, g.ha]))) : [];
  if (!teams.length) { const s: any[] = await settle(nhlGamesOn(date), [], log, 'schedule'); teams = Array.from(new Set(s.flatMap((g: any) => [g.awayTeam?.abbrev, g.homeTeam?.abbrev]).filter(Boolean))); }
  const fetchFeed = async (url: string, source: string) => parseFeed(await getText(url, 9000), source);
  const [league, perTeam] = await Promise.all([
    Promise.all(LEAGUE_FEEDS.map(f => settle(fetchFeed(f.url, f.source), [] as any[], log, f.source))),
    Promise.all(teams.map(ab => settle(fetchFeed(googleNewsRSS(`"${TEAM_NAMES[ab] || ab}" when:2d`), 'Google News'), [] as any[], log, `news ${ab}`)))
  ]);
  const cutoff = Date.now() - 3 * 86400e3; const clean = (xs: any[]) => { const seen = new Set<string>(); return xs.filter(i => Date.parse(i.at) > cutoff && i.link && !seen.has(i.link) && seen.add(i.link)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); };
  const out: any = { at: new Date().toISOString(), date, league: clean(league.flat()).slice(0, 40), teams: {} as Record<string, any[]>, ok: [] as string[], failed: log };
  teams.forEach((ab, i) => { out.teams[ab] = clean(perTeam[i]).slice(0, 10); });
  out.ok = [...LEAGUE_FEEDS.filter((f, i) => league[i].length).map(f => f.source), ...teams.filter((ab, i) => perTeam[i].length)];
  // keep the day's running archive (dedupe by link) so nothing is lost between hourly refreshes
  const prev: any = await settle(store.get(`news/${date}`, { type: 'json' }) as any, null, log, 'news archive');
  const archive = { date, updated: out.at, league: clean([...(prev?.league || []), ...out.league]).slice(0, 200), teams: {} as Record<string, any[]> };
  for (const ab of new Set([...Object.keys(prev?.teams || {}), ...teams])) archive.teams[ab] = clean([...(prev?.teams?.[ab] || []), ...(out.teams[ab] || [])]).slice(0, 40);
  await store.setJSON(`news/${date}`, archive); await store.setJSON('news/latest', out);
  console.log(`news ${date}: ${out.league.length} league items, ${teams.length} teams; failed: ${log.join(' | ') || 'none'}`);
  return out;
}
