// lib/tokenStore.ts
import { cookies } from 'next/headers';

const BASE = 'https://api.tastytrade.com';

/**
 * Get the TastyTrade session token from the httpOnly cookie.
 * Throws if not logged in.
 */
export async function getSessionToken(): Promise<string> {
  const cookieStore = cookies();
  const token = cookieStore.get('tt_session')?.value;
  if (!token) throw new Error('Not authenticated — please log in');
  return token;
}

/**
 * Make an authenticated request to TastyTrade API.
 */
export async function ttFetch(path: string, token: string) {
  const res = await fetch(`${BASE}/Users/dh735964/Downloads/login-page (1).tsx${path}`, {
    headers: { Authorization: token },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Check if the user has a session cookie set.
 */
export async function isAuthenticated(): Promise<boolean> {
  try {
    const cookieStore = cookies();
    return !!cookieStore.get('tt_session')?.value;
  } catch {
    return false;
  }
}
