import { kv } from '@vercel/kv';

const TOKEN_KEY = 'tastytrade:refresh_token';
const ACCESS_TOKEN_KEY = 'tastytrade:access_token';
const ACCESS_TOKEN_EXPIRY_KEY = 'tastytrade:access_token_expiry';

export async function saveRefreshToken(refreshToken: string): Promise<void> {
  await kv.set(TOKEN_KEY, refreshToken);
}

export async function getRefreshToken(): Promise<string | null> {
  return await kv.get<string>(TOKEN_KEY);
}

export async function saveAccessToken(accessToken: string, expiresInSeconds: number = 900): Promise<void> {
  await kv.set(ACCESS_TOKEN_KEY, accessToken, { ex: expiresInSeconds - 60 }); // expire 60s early
  await kv.set(ACCESS_TOKEN_EXPIRY_KEY, Date.now() + (expiresInSeconds * 1000));
}

export async function getCachedAccessToken(): Promise<string | null> {
  return await kv.get<string>(ACCESS_TOKEN_KEY);
}

export async function clearTokens(): Promise<void> {
  await kv.del(TOKEN_KEY);
  await kv.del(ACCESS_TOKEN_KEY);
  await kv.del(ACCESS_TOKEN_EXPIRY_KEY);
}

export async function isAuthenticated(): Promise<boolean> {
  const token = await getRefreshToken();
  return token !== null;
}
