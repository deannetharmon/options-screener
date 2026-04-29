import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  console.log("=== SCREEN API CALLED ===");

  try {
    const body = await req.json();
    const { symbols, username, password } = body;

    if (!symbols || !username || !password) {
      return NextResponse.json({ error: 'Missing symbols, username or password' }, { status: 400 });
    }

    console.log(`Logging in as ${username} for ${symbols.length} symbols`);

    // Login to get fresh token
    const loginRes = await fetch('https://api.tastytrade.com/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        login: username, 
        password: password,
        rememberMe: true 
      }),
    });

    const loginData = await loginRes.json();
    const token = loginData.session?.access_token || loginData.access_token;

    if (!token) {
      console.error("Login failed:", loginData);
      return NextResponse.json({ error: 'Login failed - wrong username or password' }, { status: 401 });
    }

    console.log("✅ Login successful - got token");

    // Mock real results for now (we'll replace with real calls later)
    const results = symbols.map((symbol: string) => ({
      symbol: symbol.toUpperCase(),
      strategy: 'BPS' as const,
      qualified: true,
      bestCandidate: {
        strategy: 'BPS' as const,
        credit: 1.45,
        pop: 72,
        shortStrike: 145,
        longStrike: 140,
      }
    }));

    return NextResponse.json({ results, token });

  } catch (err: any) {
    console.error("=== API ERROR ===", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
