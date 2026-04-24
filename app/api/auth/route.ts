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
