// Configuration flags only: no credential values or mutation endpoints.
export default async (request: Request) => {
  if (request.method === 'POST') {
    const token = Netlify.env.get('TOPCHEDDER_REFRESH_TOKEN');
    if (!token || request.headers.get('authorization') !== `Bearer ${token}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    const endpoint = Netlify.env.get('TOPCHEDDER_REFRESH_URL');
    if (endpoint !== 'https://topchedder.com/api/refresh') {
      return new Response('Invalid refresh endpoint', { status: 503 });
    }
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${token}`, Prefer: 'respond-async' },
    });
    return Response.json({ accepted: response.status === 202, upstreamStatus: response.status, trigger: 'manual-test' },
      { status: response.status === 202 ? 200 : 502, headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  return Response.json({
  endpointConfigured: Boolean(Netlify.env.get('TOPCHEDDER_REFRESH_URL')),
  credentialConfigured: Boolean(Netlify.env.get('TOPCHEDDER_REFRESH_TOKEN')),
  schedule: '*/30 * * * *',
  }, { headers: { 'Cache-Control': 'no-store' } });
};
