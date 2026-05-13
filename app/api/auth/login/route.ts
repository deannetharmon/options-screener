// app/api/auth/login/route.ts
import { NextRequest, NextResponse } from 'next/server';

const BASE = 'https://api.tastytrade.com';

export async function POST(request: NextRequest) {
  try {
    const { username, password } = await request.json();

    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password are required' }, { status: 400 });
    }

    const res = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: username, password, 'remember-me': true }),
    });

    // Read as text first — TastyTrade sometimes returns HTML on errors
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: `TastyTrade returned unexpected response (${res.status}): ${text.slice(0, 100)}` },
        { status: 502 }
      );
    }

    if (!res.ok) {
      return NextResponse.json(
        { error: data?.error?.message ?? data?.error ?? 'Invalid username or password' },
        { status: res.status }
      );
    }

    const token = data?.data?.['session-token'];
    if (!token) {
      return NextResponse.json({ error: `No session token in response: ${JSON.stringify(data).slice(0, 100)}` }, { status: 500 });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set('tt_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24,
      path: '/',
    });

    return response;
  } catch (error: any) {
    return NextResponse.json({ error: 'Internal server error: ' + error.message }, { status: 500 });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete('tt_session');
  return response;
}
