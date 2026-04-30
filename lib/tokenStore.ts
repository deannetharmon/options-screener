const BASE_URL = 'https://api.tastytrade.com';

// In-memory cache for access token (lasts 15 min per TastyTrade)
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
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedAccessToken = data.access_token;
  tokenExpiry = Date.now() + ((data.expires_in || 900) * 1000);
  return cachedAccessToken!;
}

export async function isAuthenticated(): Promise<boolean> {
  return !!process.env.TASTYTRADE_REFRESH_TOKEN;
}
