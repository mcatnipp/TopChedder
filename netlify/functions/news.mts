// Scheduled hourly: refresh RSS news for today's slate.
import { refreshNews } from '../lib/news.mts';
export default async () => { const out = await refreshNews(); return new Response(JSON.stringify({ ok: true, at: out.at, league: out.league.length, teams: Object.keys(out.teams).length, failed: out.failed })); };
export const config = { schedule: '15 * * * *' };
