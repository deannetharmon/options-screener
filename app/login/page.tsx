// app/login/page.tsx
'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const BASE = 'https://api.tastytrade.com';
const CLIENT_ID = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';

async function getAccessTokenFromRefresh(refreshToken: string, clientSecret: string): Promise<string> {
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
  return data.access_token;
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [refreshToken, setRefreshToken] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState(searchParams.get('error') ?? '');
  const [isLoading, setIsLoading] = useState(false);
  // false = checking stored creds (show spinner); true = show form
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('tt_refresh_token');
    const storedSecret = localStorage.getItem('tt_client_secret');
    if (stored && storedSecret) {
      getAccessTokenFromRefresh(stored, storedSecret)
        .then(token => {
          sessionStorage.setItem('tt_access_token', token);
          router.replace('/portfolio');
        })
        .catch((e: any) => {
          // DO NOT clear credentials — pre-fill them so user can just hit Connect
          // (or paste a new token if theirs expired). Clearing forces full re-entry.
          setRefreshToken(stored);
          setClientSecret(storedSecret);
          const msg = e.message ?? '';
          setError(
            msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('expired')
              ? 'Session expired — your refresh token may have expired. Generate a new one in TastyTrade → Settings → API → Manage → Create Grant.'
              : `Auto-login failed: ${msg || 'unknown error'}. Update your credentials below and reconnect.`
          );
          setShowForm(true);
        });
    } else {
      setShowForm(true);
    }
  }, [router]);

  const handleConnect = async () => {
    if (!refreshToken.trim()) { setError('Please enter your refresh token'); return; }
    if (!clientSecret.trim()) { setError('Please enter your client secret'); return; }
    setIsLoading(true);
    setError('');
    try {
      const accessToken = await getAccessTokenFromRefresh(refreshToken.trim(), clientSecret.trim());
      localStorage.setItem('tt_refresh_token', refreshToken.trim());
      localStorage.setItem('tt_client_secret', clientSecret.trim());
      sessionStorage.setItem('tt_access_token', accessToken);
      router.push('/portfolio');
    } catch (e: any) {
      setError(e.message || 'Could not connect');
    }
    setIsLoading(false);
  };

  if (!showForm) {
    return (
      <div className="text-white/40 text-xs tracking-widest" style={{ fontFamily: "'DM Mono', monospace" }}>
        CONNECTING...
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
        <p className="text-xs text-white/40 mb-6 leading-relaxed">
          Enter your TastyTrade credentials once — stored locally, never re-asked unless your refresh token expires.
        </p>

        <div className="mb-4 bg-white/5 border border-white/10 rounded-lg p-3">
          <p className="text-[10px] text-white/50 leading-relaxed">
            <span className="text-white/70 font-bold">One-time setup:</span><br />
            1. Log in to tastytrade.com<br />
            2. Settings → API / OAuth Applications → your app<br />
            3. Copy your <span className="text-white/70">Client Secret</span><br />
            4. Click <span className="text-white/70">Manage → Create Grant</span> → copy refresh token
          </p>
        </div>

        <div className="space-y-3 mb-4">
          <div>
            <label className="text-[10px] text-white/40 tracking-wider uppercase">Client Secret</label>
            <input
              type="password"
              value={clientSecret}
              onChange={e => setClientSecret(e.target.value)}
              className="mt-1 w-full px-4 py-3 bg-[#0a0a0a] border border-[#2c2c2c] rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-white/30 transition-colors font-mono"
              placeholder="your client secret"
            />
          </div>
          <div>
            <label className="text-[10px] text-white/40 tracking-wider uppercase">Refresh Token</label>
            <input
              type="password"
              value={refreshToken}
              onChange={e => setRefreshToken(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleConnect()}
              className="mt-1 w-full px-4 py-3 bg-[#0a0a0a] border border-[#2c2c2c] rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-white/30 transition-colors font-mono"
              placeholder="your refresh token"
            />
          </div>
        </div>

        {error && (
          <div className="mb-4 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <button
          onClick={handleConnect}
          disabled={isLoading}
          className="w-full py-3 bg-white text-black rounded-lg text-xs font-bold tracking-widest hover:bg-white/90 transition-colors disabled:opacity-40">
          {isLoading ? 'CONNECTING...' : 'CONNECT →'}
        </button>

        <p className="text-[10px] text-white/20 text-center mt-6 leading-relaxed">
          Stored locally in your browser. Never sent to our servers.
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
