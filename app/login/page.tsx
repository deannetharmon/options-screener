// app/login/page.tsx
'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const BASE = 'https://api.tastytrade.com';
const CLIENT_ID = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';

// Client secret comes ONLY from the env var — never localStorage
// This prevents stale/mismatched secrets from breaking auth
function getClientSecret(): string {
  // Guard against SSR — localStorage only exists in browser
  const stored = typeof window !== 'undefined' ? localStorage.getItem('tt_client_secret') : '';
  return process.env.NEXT_PUBLIC_TASTYTRADE_CLIENT_SECRET || stored || '';
}

async function getAccessTokenFromRefresh(
  refreshToken: string
): Promise<{ accessToken: string; newRefreshToken?: string }> {
  const clientSecret = getClientSecret();
  if (!clientSecret) throw new Error('App configuration error — client secret not configured.');

  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: clientSecret,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error_description ?? data?.error ?? 'Token exchange failed');
  if (!data.access_token) throw new Error('No access token returned');
  return {
    accessToken: data.access_token,
    newRefreshToken: data.refresh_token && data.refresh_token !== refreshToken
      ? data.refresh_token
      : undefined,
  };
}

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12C3.75 7.5 7.5 4.5 12 4.5s8.25 3 9.75 7.5c-1.5 4.5-5.25 7.5-9.75 7.5S3.75 16.5 2.25 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 002.25 12c1.5 4.5 5.25 7.5 9.75 7.5 1.76 0 3.42-.44 4.865-1.22M6.53 6.53A9.77 9.77 0 0112 4.5c4.5 0 8.25 3 9.75 7.5a10.49 10.49 0 01-2.34 3.71M6.53 6.53L3 3m3.53 3.53l10.94 10.94M16.47 16.47L21 21" />
    </svg>
  );
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [refreshToken, setRefreshToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState(searchParams.get('error') ?? '');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const existingAccess = sessionStorage.getItem('tt_access_token');
    if (existingAccess) { router.replace('/portfolio'); return; }

    const storedRefresh = localStorage.getItem('tt_refresh_token');
    if (!storedRefresh) { setIsLoading(false); return; }

    const clientSecret = getClientSecret();
    if (!clientSecret) {
      // No env var — can't auto-login, show form
      setIsLoading(false);
      return;
    }

    getAccessTokenFromRefresh(storedRefresh)
      .then(({ accessToken, newRefreshToken }) => {
        sessionStorage.setItem('tt_access_token', accessToken);
        if (newRefreshToken) localStorage.setItem('tt_refresh_token', newRefreshToken);
        router.replace('/portfolio');
      })
      .catch((e) => {
        // Refresh token is genuinely expired/revoked — clear it
        localStorage.removeItem('tt_refresh_token');
        setError(`Session expired — please paste a new refresh token. (${e.message})`);
        setIsLoading(false);
      });
  }, [router]);

  const handleConnect = async () => {
    if (!refreshToken.trim()) { setError('Please enter your refresh token'); return; }
    setIsLoading(true);
    setError('');
    try {
      const { accessToken, newRefreshToken } = await getAccessTokenFromRefresh(refreshToken.trim());
      sessionStorage.setItem('tt_access_token', accessToken);
      localStorage.setItem('tt_refresh_token', newRefreshToken ?? refreshToken.trim());
      // Cache secret locally only if env var isn't available (build didn't pick it up)
      if (!process.env.NEXT_PUBLIC_TASTYTRADE_CLIENT_SECRET) {
        const cs = getClientSecret();
        if (cs) localStorage.setItem('tt_client_secret', cs);
      }
      router.push('/portfolio');
    } catch (e: any) {
      setError(e.message || 'Could not connect');
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center gap-4">
        <div className="text-white/40 text-xs tracking-widest" style={{ fontFamily: "'DM Mono', monospace" }}>
          CONNECTING...
        </div>
        <div className="flex gap-3">
          <a href="/portfolio" className="text-white/20 text-xs tracking-widest hover:text-white/40 transition-colors">← portfolio</a>
          <span className="text-white/10">·</span>
          <a href="/" className="text-white/20 text-xs tracking-widest hover:text-white/40 transition-colors">hunter</a>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <div className="text-center mb-10">
        <h1 className="text-xl font-bold tracking-widest text-white"
          style={{ fontFamily: "'DM Mono', monospace" }}>OPTIONS HUNTER</h1>
        <p className="text-[10px] text-white/40 mt-1 tracking-wider"
          style={{ fontFamily: "'DM Mono', monospace" }}>BPS · BCS · IRON CONDOR</p>
      </div>

      <div className="bg-[#111] border border-[#222] rounded-2xl p-8">
        <h2 className="text-sm font-bold text-white tracking-wider mb-2">CONNECT YOUR ACCOUNT</h2>
        <p className="text-xs text-white/40 mb-5 leading-relaxed">
          Paste your TastyTrade refresh token. You'll only need to do this again if the token expires.
        </p>

        {/* How to get a token */}
        <div className="mb-4 bg-white/5 border border-white/10 rounded-lg p-3">
          <p className="text-[10px] text-white/50 leading-relaxed">
            <span className="text-white/70 font-bold">How to get your token:</span><br />
            1. Log in to{' '}
            <a
              href="https://my.tastytrade.com/settings/api"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 underline"
            >
              tastytrade.com → Settings → API
            </a><br />
            2. Click your app → <span className="text-white/70">Manage → Create Grant</span><br />
            3. Copy the <span className="text-white/70">Refresh Token</span> and paste below
          </p>
        </div>

        <div className="mb-4">
          <label className="text-[10px] text-white/40 tracking-wider uppercase">Refresh Token</label>
          <div className="relative mt-1">
            <input
              type={showToken ? 'text' : 'password'}
              value={refreshToken}
              onChange={e => setRefreshToken(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleConnect()}
              autoFocus
              className="w-full px-4 py-3 pr-11 bg-[#0a0a0a] border border-[#2c2c2c] rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-white/30 transition-colors font-mono"
              placeholder="paste your refresh token here"
            />
            <button
              type="button"
              onClick={() => setShowToken(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70 transition-colors"
              tabIndex={-1}
            >
              <EyeIcon open={showToken} />
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 leading-relaxed">
            {error}
          </div>
        )}

        <button
          onClick={handleConnect}
          disabled={isLoading}
          className="w-full py-3 bg-white text-black rounded-lg text-xs font-bold tracking-widest hover:bg-white/90 transition-colors disabled:opacity-40">
          {isLoading ? 'CONNECTING...' : 'CONNECT →'}
        </button>

        {/* Always-visible nav links — user is never trapped */}
        <div className="flex gap-3 mt-3">
          <a href="/portfolio" className="flex-1 py-2.5 border border-white/10 text-white/30 rounded-lg text-xs tracking-widest hover:border-white/20 hover:text-white/50 transition-colors text-center">
            ← Portfolio
          </a>
          <a href="/" className="flex-1 py-2.5 border border-white/10 text-white/30 rounded-lg text-xs tracking-widest hover:border-white/20 hover:text-white/50 transition-colors text-center">
            Hunter
          </a>
        </div>

        <p className="text-[10px] text-white/20 text-center mt-5 leading-relaxed">
          Your token is stored in your browser only. Never sent to our servers.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] p-4"
      style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');`}</style>
      <Suspense fallback={<div className="text-white/40 text-xs tracking-widest">LOADING...</div>}>
        <LoginContent />
      </Suspense>
    </div>
  );
}
