import { NextRequest, NextResponse } from 'next/server';
import { saveRefreshToken, saveAccessToken } from '@/lib/tokenStore';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');

  if (error) {
    return new NextResponse(`
      <html><body style="font-family:monospace;background:#080c14;color:#f87171;padding:40px">
        <h2>OAuth Error</h2>
        <p>${error}</p>
        <a href="/" style="color:#94a3b8">← Back</a>
      </body></html>
    `, { headers: { 'Content-Type': 'text/html' } });
  }

  if (!code) {
    return new NextResponse('No authorization code received', { status: 400 });
  }

  const redirectUri = process.env.TASTYTRADE_REDIRECT_URI || 'https://options-screener-dun.vercel.app/api/callback';

  const res = await fetch('https://api.tastytrade.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.TASTYTRADE_CLIENT_ID!,
      client_secret: process.env.TASTYTRADE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
    }),
  });

  const data = await res.json();

  if (!res.ok || !data.refresh_token) {
    return new NextResponse(`
      <html><body style="font-family:monospace;background:#080c14;color:#f87171;padding:40px">
        <h2>Token Exchange Failed</h2>
        <pre>${JSON.stringify(data, null, 2)}</pre>
        <a href="/" style="color:#94a3b8">← Back</a>
      </body></html>
    `, { headers: { 'Content-Type': 'text/html' } });
  }

  // Store tokens in KV
  await saveRefreshToken(data.refresh_token);
  if (data.access_token) {
    await saveAccessToken(data.access_token, data.expires_in || 900);
  }

  // Redirect back to app
  return NextResponse.redirect(new URL('/?connected=true', req.url));
}
