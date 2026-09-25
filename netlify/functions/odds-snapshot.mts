// Scheduled: pull NHL lines from The Odds API every 30 minutes and store a snapshot in Netlify Blobs.
import { getStore } from '@netlify/blobs';
import { buildSnapshot } from '../lib/odds-core.mts';

export default async () => {
  const key = Netlify.env.get('ODDS_API_KEY');
  if (!key) throw new Error('ODDS_API_KEY is not configured');
  const url = `https://api.the-odds-api.com/v4/sports/icehockey_nhl/odds?regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso&apiKey=${key}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Odds API ${r.status}`);
  const events = await r.json();
  const credits = { remaining: r.headers.get('x-requests-remaining'), used: r.headers.get('x-requests-used') };
  const snap = buildSnapshot(events, credits);
  const store = getStore({ name: 'odds', consistency: 'strong' });
  const at = snap.at.replace(/[:.]/g, '-');
  await store.setJSON(`snap/${at}`, snap);
  await store.setJSON('latest', snap);
  // keep an index of the last ~120 snapshots (60 hours)
  const idx = (await store.get('index', { type: 'json' })) || [];
  idx.push(snap.at);
  while (idx.length > 120) { const old = idx.shift(); try { await store.delete(`snap/${old.replace(/[:.]/g, '-')}`); } catch {} }
  await store.setJSON('index', idx);
  console.log(`odds snapshot ${snap.at}: ${snap.games.length} games, credits remaining ${credits.remaining}`);
};
export const config = { schedule: '*/30 * * * *' };
