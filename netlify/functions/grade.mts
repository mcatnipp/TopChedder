// Scheduled 12:00 UTC (8 AM ET): grade yesterday's picks from NHL finals, compute closing-line value, capture boxscores, rebuild the ledger.
import { gradePending } from '../lib/grade.mts';
export default async () => { const out = await gradePending(10); return new Response(JSON.stringify({ ok: true, ...out })); };
export const config = { schedule: '0 12 * * *' };
