const BASE_URL = 'https://api.tastytrade.com';

let cachedAccessToken: string | null = null;
let tokenExpiry: number = 0;

export async function getValidAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiry - 60000) {
    return cachedAccessToken;
  }

  const refreshToken = process.env.TASTYTRADE_REFRESH_TOKEN;
  const clientId = process.env.TASTYTRADE_CLIENT_ID;
  const clientSecret = process.env.TASTYTRADE_CLIENT_SECRET;

  if (!refreshToken) throw new Error('TASTYTRADE_REFRESH_TOKEN not configured');
  if (!clientId) throw new Error('TASTYTRADE_CLIENT_ID not configured');
  if (!clientSecret) throw new Error('TASTYTRADE_CLIENT_SECRET not configured');

  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken.trim(),
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
    }),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = JSON.parse(text);

  if (!data.access_token) {
    throw new Error(`No access token in response: ${text}`);
  }

  cachedAccessToken = data.access_token;
  tokenExpiry = Date.now() + ((data.expires_in || 900) * 1000);
  return cachedAccessToken!;
}

export async function isAuthenticated(): Promise<boolean> {
  return !!process.env.TASTYTRADE_REFRESH_TOKEN;
}
