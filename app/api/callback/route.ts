// app/api/callback/route.ts
import { NextRequest, NextResponse } from 'next/server';

const BASE = 'https://api.tastytrade.com';
const CLIENT_ID = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';
const REDIRECT_URI = 'https://options-screener-dun.vercel.app/api/callback';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const errorDesc = searchParams.get('error_description');

  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(errorDesc ?? error)}`, req.url)
    );
  }

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=No+authorization+code+received', req.url));
  }

  // Read client secret from cookie (set by login page before redirect)
  const clientSecret = req.cookies.get('tt_client_secret_temp')?.value;
  if (!clientSecret) {
    return NextResponse.redirect(new URL('/login?error=Session+lost+during+OAuth+flow.+Please+try+again.', req.url));
  }

  try {
    const res = await fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      const msg = data?.error_description ?? data?.error ?? `HTTP ${res.status}`;
      return NextResponse.redirect(
        new URL(`/login?error=${encodeURIComponent(msg)}`, req.url)
      );
    }

    if (!data.access_token || !data.refresh_token) {
      return NextResponse.redirect(
        new URL('/login?error=Incomplete+token+response+from+TastyTrade', req.url)
      );
    }

    // Pass tokens to the client via a redirect to /auth/complete
    // We can't write to localStorage from a server route, so we pass via
    // a short-lived cookie and let the client page pick them up.
    const response = NextResponse.redirect(new URL('/auth/complete', req.url));

    const cookieOpts = {
      httpOnly: false, // must be readable by client JS
      secure: true,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: 60, // 60 seconds — just long enough to complete the redirect
    };

    response.cookies.set('tt_access_token_temp', data.access_token, cookieOpts);
    response.cookies.set('tt_refresh_token_temp', data.refresh_token, cookieOpts);
    // Clear the client secret temp cookie
    response.cookies.set('tt_client_secret_temp', '', { ...cookieOpts, maxAge: 0 });

    return response;
  } catch (e: any) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(e.message ?? 'Token exchange failed')}`, req.url)
    );
  }
}
