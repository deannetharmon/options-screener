// lib/tokenStore.ts
import { cookies } from 'next/headers';

const BASE = 'https://api.tastytrade.com';
const CLIENT_ID = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';

/**
 * Get a valid access token — refreshes automatically if expired.
 */
export async function getSessionToken(): Promise<string> {
  const cookieStore = cookies();

  // Try existing access token first
  const accessToken = cookieStore.get('tt_access_token')?.value;
  if (accessToken) return accessToken;

  // Try refreshing with refresh token
  const refreshToken = cookieStore.get('tt_refresh_token')?.value;
  if (!refreshToken) throw new Error('Not authenticated — please log in');

  const clientSecret = process.env.TASTYTRADE_CLIENT_SECRET;
  if (!clientSecret) throw new Error('Server configuration error');

  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) throw new Error('Session expired — please log in again');

  const data = await res.json();
  const newToken = data.access_token;
  if (!newToken) throw new Error('Could not refresh session');

  return newToken;
}

/**
 * Make an authenticated request to TastyTrade API.
 */
export async function ttFetch(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept': 'application/json',
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Check if user has a valid session.
 */
export async function isAuthenticated(): Promise<boolean> {
  try {
    const cookieStore = cookies();
    return !!(
      cookieStore.get('tt_access_token')?.value ||
      cookieStore.get('tt_refresh_token')?.value
    );
  } catch {
    return false;
  }
}
