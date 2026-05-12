// app/login/page.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const handleLogin = async () => {
    if (!username || !password) {
      setStatus("Please enter username and password");
      return;
    }

    setIsLoading(true);
    setStatus("Logging in...");

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (res.ok && data.access_token) {
        localStorage.setItem('tt_access_token', data.access_token);
        setStatus("✅ Login successful! Redirecting...");
        setTimeout(() => router.push('/test-trade'), 1500);
      } else {
        setStatus("❌ Login failed: " + (data.error || "Check your credentials"));
      }
    } catch (err) {
      setStatus("❌ Error connecting to server");
    }

    setIsLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="bg-gray-900 p-8 rounded-xl w-full max-w-md">
        <h1 className="text-3xl font-bold text-center mb-8">TastyTrade Login</h1>

        <div className="space-y-4">
          <input
            type="text"
            placeholder="TastyTrade Username or Email"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full p-4 bg-gray-800 rounded border border-gray-700"
          />

          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full p-4 bg-gray-800 rounded border border-gray-700"
          />

          <button
            onClick={handleLogin}
            disabled={isLoading}
            className="w-full bg-green-600 hover:bg-green-700 py-4 rounded font-medium disabled:opacity-50"
          >
            {isLoading ? "Logging in..." : "Login to TastyTrade"}
          </button>

          <p className="text-center text-sm text-gray-400">
            Your credentials are sent directly to TastyTrade.<br />
            We never store your password.
          </p>
        </div>

        <div className="mt-6 text-center text-sm text-gray-500">
          {status}
        </div>
      </div>
    </div>
  );
}