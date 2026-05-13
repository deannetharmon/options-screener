// app/api/auth/login/route.ts
import { NextRequest, NextResponse } from 'next/server';

const BASE = 'https://api.tastytrade.com';

export async function POST(request: NextRequest) {
  try {
    const { username, password } = await request.json();

    if (!username || !pa/Users/dh735964/Downloads/login-page.tsxssword) {
      return NextResponse.json({ error: 'Username and password are required' }, { status: 400 });
    }

    // TastyTrade personal accounts use /sessions — NOT OAuth client credentials
    const res = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: username, password, 'remember-me': true }),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(
        { error: data?.error?.message ?? data?.error ?? 'Invalid username or password' },
        { status: res.status }
      );
    }

    const token = data?.data?.['session-token'];
    if (!token) {
      return NextResponse.json({ error: 'No session token returned' }, { status: 500 });
    }

    // Store token in httpOnly cookie — never exposed to browser JS
    const response = NextResponse.json({ ok: true });
    response.cookies.set('tt_session', token, {
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
  // Logout — clear the cookie
  const response = NextResponse.json({ ok: true });
  response.cookies.delete('tt_session');
  return response;
}
