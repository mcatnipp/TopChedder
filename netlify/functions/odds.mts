// GET /.netlify/functions/odds → latest NHL odds snapshot with consensus lines, best prices and observed moves.
// POST with ?run=1 and a bearer ODDS_ADMIN_TOKEN forces a fresh snapshot (manual test hook).
import { getStore } from '@netlify/blobs';
import { movesFor, buildSnapshot } from '../lib/odds-core.mts';

export default async (request: Request) => {
  const store = getStore({ name: 'odds', consistency: 'strong' });
  const url = new URL(request.url);
  if (request.method === 'POST' && url.searchParams.get('run') === '1') {
    const admin = Netlify.env.get('ODDS_ADMIN_TOKEN');
    if (!admin || request.headers.get('authorization') !== `Bearer ${admin}`) return new Response('Unauthorized', { status: 401 });
    const key = Netlify.env.get('ODDS_API_KEY'); if (!key) return Response.json({ error: 'ODDS_API_KEY missing' }, { status: 503 });
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/icehockey_nhl/odds?regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso&apiKey=${key}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return Response.json({ error: `Odds API ${r.status}` }, { status: 502 });
    const snap = buildSnapshot(await r.json(), { remaining: r.headers.get('x-requests-remaining'), used: r.headers.get('x-requests-used') });
    const at = snap.at.replace(/[:.]/g, '-');
    await store.setJSON(`snap/${at}`, snap); await store.setJSON('latest', snap);
    const idx = (await store.get('index', { type: 'json' })) || []; idx.push(snap.at); await store.setJSON('index', idx);
    return Response.json({ ok: true, at: snap.at, games: snap.games.length, credits: snap.credits }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const latest = await store.get('latest', { type: 'json' });
  if (!latest) return Response.json({ ok: false, at: null, games: [], snapshots: 0, note: 'No snapshot yet. The scheduled function runs every 30 minutes.' }, { headers: { 'Cache-Control': 'no-store' } });
  const idx: string[] = (await store.get('index', { type: 'json' })) || [];
  // Moves are measured against the first snapshot in the last 24 hours (the "open" for the slate).
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const keys = idx.filter(t => Date.parse(t) >= cutoff);
  const sample = keys.length > 10 ? [keys[0], ...keys.slice(-9)] : keys; // open + recent tail
  const snaps: any[] = [];
  for (const t of sample) { if (t === latest.at) { snaps.push(latest); continue; } const s = await store.get(`snap/${t.replace(/[:.]/g, '-')}`, { type: 'json' }); if (s) snaps.push(s); }
  if (!snaps.find(s => s.at === latest.at)) snaps.push(latest);
  snaps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const moves = movesFor(snaps);
  const games = latest.games.map((g: any) => ({ ...g, moves: moves[g.id] || [], open: (snaps[0].games || []).find((x: any) => x.id === g.id)?.cons || null }));
  return Response.json({ ok: true, at: latest.at, first_at: snaps[0]?.at || latest.at, snapshots: keys.length || idx.length, credits: latest.credits, games },
    { headers: { 'Cache-Control': 'public, max-age=120' } });
};
