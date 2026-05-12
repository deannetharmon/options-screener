import { NextRequest, NextResponse } from 'next/server';

const BASE_URL = 'https://api.tastytrade.com';

export async function POST(req: NextRequest) {
  const steps: any[] = [];

  try {
    const { refreshToken } = await req.json();

    // Step 1: check env vars
    const clientId = process.env.TASTYTRADE_CLIENT_ID;
    const clientSecret = process.env.TASTYTRADE_CLIENT_SECRET;
    const envRefreshToken = process.env.NEXT_PUBLIC_TASTYTRADE_REFRESH_TOKEN;

    steps.push({
      step: 'env_vars',
      TASTYTRADE_CLIENT_ID: clientId ? `set (${clientId.slice(0, 6)}...)` : 'MISSING',
      TASTYTRADE_CLIENT_SECRET: clientSecret ? `set (${clientSecret.slice(0, 4)}...)` : 'MISSING',
      NEXT_PUBLIC_TASTYTRADE_REFRESH_TOKEN: envRefreshToken ? `set (${envRefreshToken.slice(0, 8)}...)` : 'MISSING',
      refreshTokenFromClient: refreshToken ? `set (${refreshToken.slice(0, 8)}...)` : 'MISSING',
    });

    // Step 2: try token refresh with urlencoded (lib/tastytrade.ts method)
    const tokenToUse = refreshToken || envRefreshToken;
    if (!tokenToUse) {
      return NextResponse.json({ steps, error: 'No refresh token available' });
    }

    steps.push({ step: 'attempting_token_refresh', method: 'urlencoded', url: `${BASE_URL}/oauth/token` });

    const res = await fetch(`${BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenToUse,
        client_id: clientId ?? '',
        client_secret: clientSecret ?? '',
      }),
    });

    const responseText = await res.text();
    steps.push({
      step: 'token_refresh_response',
      status: res.status,
      ok: res.ok,
      body: responseText.slice(0, 300),
    });

    if (!res.ok) {
      return NextResponse.json({ steps, error: `Token refresh failed: ${res.status}` });
    }

    const tokenData = JSON.parse(responseText);
    const accessToken = tokenData.access_token;
    steps.push({ step: 'got_access_token', token: `${accessToken.slice(0, 12)}...` });

    // Step 3: try accounts endpoint
    const accountsRes = await fetch(`${BASE_URL}/customers/me/accounts`, {
      headers: { Authorization: accessToken },
    });
    const accountsText = await accountsRes.text();
    steps.push({
      step: 'accounts_endpoint',
      status: accountsRes.status,
      ok: accountsRes.ok,
      body: accountsText.slice(0, 300),
    });

    return NextResponse.json({ steps, success: accountsRes.ok });

  } catch (e: any) {
    return NextResponse.json({ steps, error: e.message }, { status: 500 });
  }
}
