// app/api/auth/login/route.ts
// Redirects user to TastyTrade OAuth authorization page
import { NextResponse } from 'next/server';

const CLIENT_ID = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';
const REDIRECT_URI = 'https://options-screener-dun.vercel.app/api/callback';
const AUTH_URL = 'https://api.tastytrade.com/oauth/authorize';

export async function GET() {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'read trade openid',
  });

  return NextResponse.redirect(`${AUTH_URL}?${params.toString()}`);
}

// Keep DELETE for logout
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete('tt_refresh_token');
  response.cookies.delete('tt_access_token');
  response.cookies.delete('tt_session');
  return response;
}
