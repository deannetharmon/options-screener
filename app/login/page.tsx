// app/login/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const errorParam = searchParams.get('error');

  const [error, setError] = useState(errorParam ?? '');

  useEffect(() => {
    fetch('/api/auth/status')
      .then(r => r.json())
      .then(d => { if (d.authenticated) router.replace('/portfolio'); })
      .catch(() => {});
  }, [router]);

  const handleConnect = () => {
    window.location.href = '/api/auth/login';
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] p-4"
      style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');`}</style>

      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <h1 className="text-xl font-bold tracking-widest text-white"
            style={{ fontFamily: "'DM Mono', monospace" }}>OPTIONS HUNTER</h1>
          <p className="text-[10px] text-white/40 mt-1 tracking-wider"
            style={{ fontFamily: "'DM Mono', monospace" }}>BPS · BCS · IRON CONDOR</p>
        </div>

        <div className="bg-[#111] border border-[#222] rounded-2xl p-8">
          <h2 className="text-sm font-bold text-white tracking-wider mb-2">CONNECT YOUR ACCOUNT</h2>
          <p className="text-xs text-white/40 mb-8 leading-relaxed">
            Sign in with your TastyTrade account to view and manage your options portfolio.
          </p>

          {error && (
            <div className="mb-4 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              {error === 'server_config' ? 'Server configuration error — contact support' :
               error === 'no_code' ? 'Authorization was cancelled' :
               error === 'access_denied' ? 'Access was denied — please try again' :
               `Authorization failed: ${error}`}
            </div>
          )}

          <button
            onClick={handleConnect}
            className="w-full py-3 bg-white text-black rounded-lg text-xs font-bold tracking-widest hover:bg-white/90 transition-colors">
            CONNECT WITH TASTYTRADE →
          </button>

          <p className="text-[10px] text-white/20 text-center mt-6 leading-relaxed">
            You'll be redirected to TastyTrade to authorize access.<br />
            Your credentials are never stored on our servers.
          </p>
        </div>
      </div>
    </div>
  );
}
