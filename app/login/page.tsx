// app/login/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  // If already logged in, skip to portfolio
  useEffect(() => {
    fetch('/api/auth/status')
      .then(r => r.json())
      .then(d => { if (d.authenticated) router.replace('/portfolio'); })
      .catch(() => {});
  }, [router]);

  const handleLogin = async () => {
    if (!username || !password) { setError('Please enter username and password'); return; }
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
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
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] p-4"
      style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>

      {/* Inject DM Sans font */}
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');`}</style>

      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-10">
          <h1 className="text-xl font-bold tracking-widest text-white"
            style={{ fontFamily: "'DM Mono', monospace" }}>OPTIONS HUNTER</h1>
          <p className="text-[10px] text-white/40 mt-1 tracking-wider"
            style={{ fontFamily: "'DM Mono', monospace" }}>BPS · BCS · IRON CONDOR</p>
        </div>

        {/* Card */}
        <div className="bg-[#111] border border-[#222] rounded-2xl p-8">
          <h2 className="text-sm font-bold text-white tracking-wider mb-6">
            SIGN IN WITH TASTYTRADE
          </h2>

          <div className="space-y-3">
            <div>
              <label className="text-[10px] text-white/40 tracking-wider uppercase">Username / Email</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                autoComplete="username"
                className="mt-1 w-full px-4 py-3 bg-[#0a0a0a] border border-[#2c2c2c] rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-white/30 transition-colors"
                placeholder="your@email.com"
              />
            </div>

            <div>
              <label className="text-[10px] text-white/40 tracking-wider uppercase">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                autoComplete="current-password"
                className="mt-1 w-full px-4 py-3 bg-[#0a0a0a] border border-[#2c2c2c] rounded-lg text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-white/30 transition-colors"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              onClick={handleLogin}
              disabled={isLoading}
              className="w-full py-3 mt-2 bg-white text-black rounded-lg text-xs font-bold tracking-widest hover:bg-white/90 transition-colors disabled:opacity-40">
              {isLoading ? 'SIGNING IN...' : 'SIGN IN →'}
            </button>
          </div>

          <p className="text-[10px] text-white/20 text-center mt-6 leading-relaxed">
            Your credentials are sent directly to TastyTrade<br />and never stored on our servers.
          </p>
        </div>
      </div>
    </div>
  );
}
