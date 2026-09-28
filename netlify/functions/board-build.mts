// Scheduled: build today's board. 13:00 UTC (9 AM ET, lines + projected goalies), 15:00 (11 AM ET, the confirmation window), 17:00 (1 PM ET, after morning skates), 22:00 (6 PM ET, late confirmations).
// Games that have already started are frozen at their last pre-game numbers.
import { buildBoard } from '../lib/build.mts';
export default async () => { const out = await buildBoard(); return new Response(JSON.stringify({ ok: true, date: out.date, games: out.games.length, ms: out.ms, problems: out.sources.problems })); };
export const config = { schedule: '0 13,15,17,22 * * *' };
