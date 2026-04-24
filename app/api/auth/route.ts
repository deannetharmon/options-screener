import { NextRequest, NextResponse } from 'next/server';
import { authenticate } from '@/lib/tastytrade';

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();
    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
    }
    const session = await authenticate(username, password);
    return NextResponse.json({ token: session.token, expiresAt: session.expiresAt });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Authentication failed' }, { status: 401 });
  }
}

export async function GET() {
  const token = process.env.TASTYTRADE_SESSION_TOKEN;
  
  try {
    const testRes = await fetch('https://api.tastytrade.com/market-metrics?symbols=MU', {
      headers: { Authorization: token ?? '' },
    });
    
    const text = await testRes.text();
    
    return NextResponse.json({
      tokenExists: !!token,
      tokenPrefix: token?.substring(0, 20),
      apiStatus: testRes.status,
      apiResponse: text.substring(0, 500),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message });
  }
}
