// app/login/page.tsx
'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const errorParam = searchParams.get('error');
  const [refreshToken, setRefreshToken] = useState('');
  const [error, setError] = useState(errorParam ?? '');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    fetch('/api/auth/status')
      .then(r => r.json())
      .then(d => { if (d.authenticated) router.replace('/portfolio'); })
      .catch(() => {});
  }, [router]);

  const handleConnect = async () => {
    if (!refreshToken.trim()) { setError('Please enter your refresh token'); return; }
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refreshToken.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        router.push('/portfolio');
      } else {
        setError(data.error || 'Login failed');
      }
    } catch {
      setError('Could not connect to server');
    }
    setIsLoading(false);
  };

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
          Enter your TastyTrade refresh token to connect your account.
        </p>

        <div className="mb-4 bg-white/5 border border-white/10 rounded-lg p-3">
          <p className="text-[10px] text-white/50 leading-relaxed">
            <span className="text-white/70 font-bold">How to get your token:</span><br />
            1. Log in to tastytrade.com<br />
            2. Go to Settings → API / OAuth Applications<br />
            3. Click your app → <span className="text-white/70">Manage → Create Grant</span><br />
            4. Copy the refresh token and paste it below
          </p>
        </div>

        <div className="mb-4">
          <label className="text-[10px] text-white/40 tracking-wider uppercase">Refresh Token</label>
          <input
            type="password"
            value={refreshToken}
            onChange={e => setRefreshToken(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleConnect()}
            className="mt-1 w-full px-4 py-3 bg-[#0a0a0a] border border-[#2c2c2c] rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-white/30 transition-colors font-mono"
            placeholder="paste your refresh token here"
          />
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
          Your token is stored securely and never shared.<br />
          Refresh tokens never expire.
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
