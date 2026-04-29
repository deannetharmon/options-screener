import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { symbols, username, password } = await req.json();

    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
    }

    // Login to TastyTrade to get fresh token
    const loginRes = await fetch('https://api.tastytrade.com/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: username, password, rememberMe: true }),
    });

    const loginData = await loginRes.json();
    const token = loginData.session?.access_token || loginData.access_token;

    if (!token) {
      console.error("Login failed", loginData);
      return NextResponse.json({ error: 'Login failed - check credentials' }, { status: 401 });
    }

    console.log("✅ Got fresh token");

    // Now use the token for real calls...
    const results = symbols.map((symbol: string) => ({
      symbol,
      strategy: 'BPS',
      qualified: true,
      bestCandidate: {
        strategy: 'BPS',
        credit: 1.45,
        pop: 72,
      }
    }));

    return NextResponse.json({ results, token });

  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
