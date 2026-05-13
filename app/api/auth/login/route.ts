// app/api/auth/login/route.ts
import { NextRequest, NextResponse } from 'next/server';

const BASE = 'https://api.tastytrade.com';
const CLIENT_ID = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';

export async function POST(request: NextRequest) {
  try {
    const { refreshToken } = await request.json();
    if (!refreshToken) {
      return NextResponse.json({ error: 'Refresh token is required' }, { status: 400 });
    }

    const clientSecret = process.env.TASTYTRADE_CLIENT_SECRET;
    if (!clientSecret) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // Try JSON body instead of form-encoded
    const res = await fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        client_secret: clientSecret,
      }),
    });

    const text = await res.text();

    // Log full response for debugging
    console.log('[TT token] status:', res.status);
    console.log('[TT token] response:', text.slice(0, 500));

    let data: any;
    try { data = JSON.parse(text); } catch {
      return NextResponse.json({ 
        error: `TastyTrade error (${res.status}): ${text.slice(0, 200)}` 
      }, { status: 502 });
    }

    if (!res.ok) {
      return NextResponse.json(
        { error: data?.error_description ?? data?.error ?? `Auth failed (${res.status})` },
        { status: 401 }
      );
    }

    const accessToken = data.access_token;
    if (!accessToken) {
      return NextResponse.json({ 
        error: `No access token. Response: ${JSON.stringify(data).slice(0, 200)}` 
      }, { status: 500 });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set('tt_access_token', accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 60 * 60,
      path: '/',
    });
    response.cookies.set('tt_refresh_token', refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
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
