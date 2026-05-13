// app/api/auth/login/route.ts
// Since TastyTrade blocks server-to-server OAuth calls,
// this route validates the token by making a lightweight API call using it,
// then stores it in a cookie if valid.
import { NextRequest, NextResponse } from 'next/server';

const BASE = 'https://api.tastytrade.com';

export async function POST(request: NextRequest) {
  try {
    const { accessToken } = await request.json();
    if (!accessToken) {
      return NextResponse.json({ error: 'Access token is required' }, { status: 400 });
    }

    // Validate the token by calling a lightweight endpoint
    const res = await fetch(`${BASE}/customers/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    // Token is valid — store in httpOnly cookie
    const response = NextResponse.json({ ok: true });
    response.cookies.set('tt_access_token', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24, // 24 hours
      path: '/',
    });

    return response;
  } catch (error: any) {
    return NextResponse.json({ error: 'Internal server error: ' + error.message }, { status: 500 });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete('tt_access_token');
  response.cookies.delete('tt_refresh_token');
  response.cookies.delete('tt_session');
  return response;
}
