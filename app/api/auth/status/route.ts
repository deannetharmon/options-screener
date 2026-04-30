import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/tokenStore';

export async function GET() {
  try {
    const authenticated = await isAuthenticated();
    return NextResponse.json({ authenticated });
  } catch (e: any) {
    return NextResponse.json({ authenticated: false, error: e.message });
  }
}
