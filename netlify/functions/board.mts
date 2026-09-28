// Public read API for the board data in Netlify Blobs + admin actions (Bearer ODDS_ADMIN_TOKEN).
//  GET ?what=day[&date=]     board for a date (default: today ET, else the latest available)
//  GET ?what=index | ledger | news | results&date= | box&gid= | pbp&gid= | starters&date= | bets&date= | history&date= | inputs&date= | export&type=days|results|box|pbp|history|inputs|news|starters|bets[&key=]
//  POST ?run=build[&date=] | grade[&date=] | news | goalie (json {date, game, side, name, status, note}) | ratings (json teams.json) | ratings-clear
//       ?run=bet (json {date, game:'fla-car', market:'ml'|'total'|'pl'|'p1'|'reg3'|'tt', side, line, odds, stake, book, note}) | bet-delete (json {date, id})
import { getStore } from '@netlify/blobs';
import { buildBoard } from '../lib/build.mts';
import { gradeDate, gradePending, rebuildLedger } from '../lib/grade.mts';
import { refreshNews } from '../lib/news.mts';
import { todayET } from '../lib/sources.mts';

const json = (b: any, status = 200, maxAge = 60) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${maxAge}`, 'access-control-allow-origin': '*' } });
export default async (req: Request) => {
  const store = getStore({ name: 'board', consistency: 'strong' }); const u = new URL(req.url); const q = (k: string) => u.searchParams.get(k);
  if (req.method === 'POST') {
    const tok = Netlify.env.get('ODDS_ADMIN_TOKEN'); const auth = req.headers.get('authorization') || '';
    if (!tok || auth !== `Bearer ${tok}`) return json({ ok: false, error: 'unauthorized' }, 401, 0);
    const run = q('run'); const log: string[] = [];
    try {
      if (run === 'build') { const out = await buildBoard({ date: q('date') || undefined }); return json({ ok: true, date: out.date, games: out.games.length, ms: out.ms, problems: out.sources.problems }, 200, 0); }
      if (run === 'grade') { if (q('date')) { const r = await gradeDate(q('date')!, log); await rebuildLedger(log); return json({ ok: true, result: r, problems: log }, 200, 0); } return json({ ok: true, ...(await gradePending(30, log)) }, 200, 0); }
      if (run === 'news') { const n = await refreshNews(q('date') || undefined); return json({ ok: true, at: n.at, failed: n.failed }, 200, 0); }
      if (run === 'goalie') { const b: any = await req.json(); const date = b.date || todayET(); const ov: any = (await store.get(`overrides/${date}`, { type: 'json' })) || {}; ov[b.game] = { ...(ov[b.game] || {}), [b.side]: { name: b.name, status: b.status || 'confirmed', note: b.note || 'Set by admin override.' } }; await store.setJSON(`overrides/${date}`, ov); const out = await buildBoard({ date }); return json({ ok: true, overrides: ov, rebuilt: out.games.length }, 200, 0); }
      if (run === 'ratings') { const b: any = await req.json(); if (!b?.teams?.length) return json({ ok: false, error: 'expected teams.json shape' }, 400, 0); await store.setJSON('config/ratings', { ...b, updated: new Date().toISOString() }); return json({ ok: true, teams: b.teams.length }, 200, 0); }
      if (run === 'bet') { const b: any = await req.json(); const date = b.date || todayET(); if (!b.game || !b.market || !b.side || !Number.isFinite(+b.odds)) return json({ ok: false, error: 'need game, market, side, odds' }, 400, 0); const cur: any[] = (await store.get(`bets/${date}`, { type: 'json' })) || []; const bet = { id: Math.random().toString(36).slice(2, 10), at: new Date().toISOString(), date, game: b.game, market: b.market, side: b.side, line: b.line ?? null, odds: +b.odds, stake: +b.stake || 1, book: b.book || null, note: b.note || null }; cur.push(bet); await store.setJSON(`bets/${date}`, cur); return json({ ok: true, bet, count: cur.length }, 200, 0); }
      if (run === 'bet-delete') { const b: any = await req.json(); const cur: any[] = (await store.get(`bets/${b.date}`, { type: 'json' })) || []; const next = cur.filter(x => x.id !== b.id); await store.setJSON(`bets/${b.date}`, next); return json({ ok: true, count: next.length }, 200, 0); }
      if (run === 'ratings-clear') { await store.delete('config/ratings'); return json({ ok: true }, 200, 0); }
      return json({ ok: false, error: 'unknown run' }, 400, 0);
    } catch (e: any) { return json({ ok: false, error: String(e?.message || e), problems: log }, 500, 0); }
  }
  const what = q('what') || 'day';
  if (what === 'day') {
    const idx: any = (await store.get('index', { type: 'json' })) || { dates: [] }; const today = todayET(); let date = q('date');
    if (!date || !idx.dates.includes(date)) { const up = idx.dates.filter((d: string) => d >= today); date = up[0] || idx.dates[idx.dates.length - 1] || null; }
    if (!date) return json({ ok: false, error: 'no boards yet', dates: idx.dates }, 404, 30);
    const board: any = await store.get(`days/${date}`, { type: 'json' }); if (!board) return json({ ok: false, error: 'board missing' }, 404, 30);
    const news: any = await store.get('news/latest', { type: 'json' });
    if (news?.teams) for (const g of board.games) g.feed = { at: news.at, away: news.teams[g.aa] || [], home: news.teams[g.ha] || [] };
    board.dates = idx.dates; board.news_league = news?.league?.slice(0, 20) || []; return json(board, 200, 60);
  }
  if (what === 'index') return json((await store.get('index', { type: 'json' })) || { dates: [], built: {} }, 200, 60);
  if (what === 'ledger') return json((await store.get('ledger', { type: 'json' })) || null, 200, 120);
  if (what === 'news') return json((await store.get(q('date') ? `news/${q('date')}` : 'news/latest', { type: 'json' })) || { league: [], teams: {} }, 200, 120);
  if (what === 'results') return json((await store.get(`results/${q('date')}`, { type: 'json' })) || null, 200, 120);
  if (what === 'box') return json((await store.get(`box/${q('gid')}`, { type: 'json' })) || null, 200, 3600);
  if (what === 'pbp') return json((await store.get(`pbp/${q('gid')}`, { type: 'json' })) || null, 200, 3600);
  if (what === 'starters') return json((await store.get(`starters/${q('date') || todayET()}`, { type: 'json' })) || [], 200, 60);
  if (what === 'bets') return json((await store.get(`bets/${q('date') || todayET()}`, { type: 'json' })) || [], 200, 0);
  if (what === 'history' || what === 'inputs') { const { blobs } = await store.list({ prefix: `${what}/${q('date')}/` }); if (q('key')) return json(await store.get(q('key')!, { type: 'json' }), 200, 3600); return json({ keys: blobs.map(b => b.key) }, 200, 60); }
  if (what === 'export') { const type = q('type') || 'results'; if (q('key')) return json(await store.get(q('key')!, { type: 'json' }), 200, 3600); const { blobs } = await store.list({ prefix: `${type}/` }); return json({ type, count: blobs.length, keys: blobs.map(b => b.key) }, 200, 60); }
  return json({ ok: false, error: 'unknown what' }, 400, 0);
};
