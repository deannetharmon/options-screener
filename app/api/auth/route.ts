import { NextRequest, NextResponse } from 'next/server';

const TOKEN_ENDPOINT = 'https://api.tastyworks.com/oauth/token';

async function getAccessToken(): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.TASTYTRADE_REFRESH_TOKEN!,
      client_secret: process.env.TASTYTRADE_CLIENT_SECRET!,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to get access token: ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

export async function POST(req: NextRequest) {
  try {
    const token = await getAccessToken();
    return NextResponse.json({ token, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
}

export async function GET() {
  try {
    const token = await getAccessToken();
    
    const testRes = await fetch('https://api.tastytrade.com/market-metrics?symbols=MU', {
      headers: { Authorization: `Bearer ${token}` },
    });
    
    const text = await testRes.text();
    
    return NextResponse.json({
      tokenObtained: true,
      apiStatus: testRes.status,
      apiResponse: text.substring(0, 500),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message });
  }
}
