import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/tokenStore';

export async function GET() {
  const authenticated = await isAuthenticated();
  return NextResponse.json({ authenticated });
}
