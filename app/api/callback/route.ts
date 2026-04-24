import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  
  if (!code) {
    return new NextResponse('No code received', { status: 400 });
  }

  const res = await fetch('https://api.tastytrade.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.TASTYTRADE_CLIENT_ID!,
      client_secret: process.env.TASTYTRADE_CLIENT_SECRET!,
      redirect_uri: 'https://options-screener-dun.vercel.app/api/callback',
    }),
  });

  const data = await res.json();
  
  return new NextResponse(`
    <h2>OAuth Complete</h2>
    <p><strong>Refresh Token:</strong></p>
    <textarea rows="4" cols="80">${data.refresh_token ?? JSON.stringify(data)}</textarea>
    <p>Copy the refresh token above and add it to Vercel as TASTYTRADE_REFRESH_TOKEN</p>
  `, { headers: { 'Content-Type': 'text/html' } });
}
