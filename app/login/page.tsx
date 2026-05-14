// app/login/page.tsx
'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const BASE = 'https://api.tastytrade.com';
const CLIENT_ID = '4d4c851b-bdaf-4ac9-b39b-811e604739f2';

async function loginWithPassword(username: string, password: string, clientSecret: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      username,
      password,
      client_id: CLIENT_ID,
      client_secret: clientSecret,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error_description ?? data?.error ?? 'Login failed');
  if (!data.access_token) throw new Error('No access token returned');
  if (!data.refresh_token) throw new Error('No refresh token returned — check your OAuth app has offline_access scope');
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

async function refreshAccessToken(refreshToken: string, clientSecret: string): Promise<string> {
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
  if (!res.ok) throw new Error(data?.error_description ?? data?.error ?? 'Token refresh failed');
  if (!data.access_token) throw new Error('No access token returned');
  return data.access_token;
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState(searchParams.get('error') ?? '');
  const [isLoading, setIsLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [isReauth, setIsReauth] = useState(false);

  useEffect(() => {
    const storedRefresh = localStorage.getItem('tt_refresh_token');
    const storedSecret = localStorage.getItem('tt_client_secret');
    if (storedRefresh && storedSecret) {
      refreshAccessToken(storedRefresh, storedSecret)
        .then(accessToken => {
          sessionStorage.setItem('tt_access_token', accessToken);
          router.replace('/portfolio');
        })
        .catch(() => {
          setClientSecret(storedSecret);
          setIsReauth(true);
          setError("Your session expired. Sign in with your TastyTrade username and password to reconnect — you won't need to do this often.");
          setShowForm(true);
        });
    } else {
      setShowForm(true);
    }
  }, [router]);

  const handleLogin = async () => {
    if (!username.trim()) { setError('Please enter your TastyTrade username'); return; }
    if (!password.trim()) { setError('Please enter your password'); return; }
    if (!clientSecret.trim()) { setError('Please enter your Client Secret'); return; }
    setIsLoading(true);
    setError('');
    try {
      const { accessToken, refreshToken } = await loginWithPassword(
        username.trim(), password.trim(), clientSecret.trim()
      );
      localStorage.setItem('tt_refresh_token', refreshToken);
      localStorage.setItem('tt_client_secret', clientSecret.trim());
      sessionStorage.setItem('tt_access_token', accessToken);
      router.push('/portfolio');
    } catch (e: any) {
      setError(e.message || 'Login failed — check your credentials');
    }
    setIsLoading(false);
  };

  const onEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') handleLogin(); };

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
        {isReauth ? (
          <>
            <h2 className="text-sm font-bold text-white tracking-wider mb-2">SESSION EXPIRED</h2>
            <p className="text-xs text-white/40 mb-6 leading-relaxed">
              Sign in with your TastyTrade credentials to refresh your session. This happens every few months.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-sm font-bold text-white tracking-wider mb-2">CONNECT YOUR ACCOUNT</h2>
            <p className="text-xs text-white/40 mb-6 leading-relaxed">
              Sign in once — the app handles token refresh automatically from here.
            </p>
            <div className="mb-4 bg-white/5 border border-white/10 rounded-lg p-3">
              <p className="text-[10px] text-white/50 leading-relaxed">
                <span className="text-white/70 font-bold">One-time setup — Client Secret:</span><br />
                1. Log in to tastytrade.com<br />
                2. Settings → API / OAuth Applications → your app<br />
                3. Copy your <span className="text-white/70">Client Secret</span> and paste below
              </p>
            </div>
          </>
        )}

        <div className="space-y-3 mb-4">
          <div>
            <label className="text-[10px] text-white/40 tracking-wider uppercase">TastyTrade Username</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              onKeyDown={onEnter}
              autoComplete="username"
              className="mt-1 w-full px-4 py-3 bg-[#0a0a0a] border border-[#2c2c2c] rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-white/30 transition-colors font-mono"
              placeholder="your username or email"
            />
          </div>

          <div>
            <label className="text-[10px] text-white/40 tracking-wider uppercase">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={onEnter}
              autoComplete="current-password"
              className="mt-1 w-full px-4 py-3 bg-[#0a0a0a] border border-[#2c2c2c] rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-white/30 transition-colors font-mono"
              placeholder="your password"
            />
          </div>

          {!isReauth && (
            <div>
              <label className="text-[10px] text-white/40 tracking-wider uppercase flex items-center justify-between">
                <span>Client Secret</span>
                <button
                  type="button"
                  onClick={() => setShowSecret(v => !v)}
                  className="text-white/30 hover:text-white/60 transition-colors normal-case tracking-normal text-[9px]"
                >{showSecret ? 'hide' : 'show'}</button>
              </label>
              <input
                type={showSecret ? 'text' : 'password'}
                value={clientSecret}
                onChange={e => setClientSecret(e.target.value)}
                onKeyDown={onEnter}
                className="mt-1 w-full px-4 py-3 bg-[#0a0a0a] border border-[#2c2c2c] rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-white/30 transition-colors font-mono"
                placeholder="your OAuth client secret"
              />
            </div>
          )}
        </div>

        {isReauth && (
          <p className="text-[10px] text-white/30 mb-4">
            Your Client Secret is already saved — only username and password needed.
          </p>
        )}

        {error && (
          <div className="mb-4 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 leading-relaxed">
            {error}
          </div>
        )}

        <button
          onClick={handleLogin}
          disabled={isLoading}
          className="w-full py-3 bg-white text-black rounded-lg text-xs font-bold tracking-widest hover:bg-white/90 transition-colors disabled:opacity-40">
          {isLoading ? 'CONNECTING...' : isReauth ? 'RECONNECT →' : 'CONNECT →'}
        </button>

        <p className="text-[10px] text-white/20 text-center mt-6 leading-relaxed">
          Credentials are never sent to our servers. Token refresh is automatic until expiry.
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
