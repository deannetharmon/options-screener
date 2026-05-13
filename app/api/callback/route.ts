// app/api/callback/route.ts
// Handles OAuth callback from TastyTrade — exchanges auth code for tokens
import { NextRequest, NextResponse } from 'next/server';

const BASE = 'https://api.tastytrade.com';
const CLIENT_ID = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';
const REDIRECT_URI = 'https://options-screener-dun.vercel.app/api/callback';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get('code');
  const error = searchParams.get('error');

  if (error) {
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error)}`, req.url));
  }

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=no_code', req.url));
  }

  const clientSecret = process.env.TASTYTRADE_CLIENT_SECRET;
  if (!clientSecret) {
    return NextResponse.redirect(new URL('/login?error=server_config', req.url));
  }

  try {
    // Exchange auth code for access + refresh tokens
    const res = await fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch {
      return NextResponse.redirect(new URL('/login?error=invalid_response', req.url));
    }

    if (!res.ok) {
      const msg = data?.error_description ?? data?.error ?? 'token_exchange_failed';
      return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(msg)}`, req.url));
    }

    const accessToken = data.access_token;
    const refreshToken = data.refresh_token;

    if (!accessToken) {
      return NextResponse.redirect(new URL('/login?error=no_access_token', req.url));
    }

    // Store both tokens in httpOnly cookies
    const response = NextResponse.redirect(new URL('/portfolio', req.url));

    response.cookies.set('tt_access_token', accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 60 * 60, // 1 hour
      path: '/',
    });

    if (refreshToken) {
      response.cookies.set('tt_refresh_token', refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 365, // 1 year — refresh tokens don't expire
        path: '/',
      });
    }

    return response;
  } catch (e: any) {
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(e.message)}`, req.url));
  }
}
