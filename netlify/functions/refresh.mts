// Auxiliary scheduler only. The public dashboard remains hosted on Sites.
export default async () => {
  const endpoint = Netlify.env.get('TOPCHEDDER_REFRESH_URL');
  const token = Netlify.env.get('TOPCHEDDER_REFRESH_TOKEN');
  if (!endpoint || !token) throw new Error('TopChedder scheduler configuration is missing');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.pathname !== '/api/refresh') throw new Error('Invalid refresh endpoint');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Prefer: 'respond-async', 'X-TopChedder-Trigger': 'netlify-schedule' },
    redirect: 'error',
    signal: AbortSignal.timeout(25000),
  });
  if (response.status !== 202) throw new Error(`Refresh was not accepted (${response.status})`);
  console.log('TopChedder refresh accepted; completion is recorded by the dashboard.');
};
export const config = { schedule: '*/30 * * * *' };
