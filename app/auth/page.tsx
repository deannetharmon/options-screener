// app/auth/complete/page.tsx
// Intermediate page that reads tokens from cookies into localStorage,
// then redirects to /portfolio. Needed because the API callback route
// is server-side and can't write to localStorage directly.
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find(r => r.startsWith(name + '='));
  return match ? decodeURIComponent(match.split('=')[1]) : null;
}

function deleteCookie(name: string) {
  document.cookie = `${name}=; path=/; max-age=0; secure; samesite=lax`;
}

export default function AuthComplete() {
  const router = useRouter();
  const [error, setError] = useState('');

  useEffect(() => {
    const accessToken = getCookie('tt_access_token_temp');
    const refreshToken = getCookie('tt_refresh_token_temp');

    if (!accessToken || !refreshToken) {
      setError('Token cookies not found. The OAuth flow may have timed out. Please try again.');
      return;
    }

    try {
      localStorage.setItem('tt_refresh_token', refreshToken);
      sessionStorage.setItem('tt_access_token', accessToken);
    } catch {
      setError('Could not save tokens to local storage. Check your browser privacy settings.');
      return;
    }

    // Clean up temp cookies
    deleteCookie('tt_access_token_temp');
    deleteCookie('tt_refresh_token_temp');

    router.replace('/portfolio');
  }, [router]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] p-4">
        <div className="w-full max-w-sm bg-[#111] border border-[#222] rounded-2xl p-8 text-center">
          <p className="text-red-400 text-sm mb-4">{error}</p>
          <a href="/login" className="text-xs text-white/40 hover:text-white/70 underline">
            Back to login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a]">
      <p className="text-white/40 text-xs tracking-widest" style={{ fontFamily: "'DM Mono', monospace" }}>
        COMPLETING LOGIN...
      </p>
    </div>
  );
}
