import { NextResponse } from 'next/server';

export async function GET() {
  const clientId = process.env.TASTYTRADE_CLIENT_ID!;
  const redirectUri = process.env.TASTYTRADE_REDIRECT_URI || 'https://options-screener-dun.vercel.app/api/callback';

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'read trade openid',
  });

  const authUrl = `https://api.tastytrade.com/oauth/authorize?${params.toString()}`;
  return NextResponse.redirect(authUrl);
}
