// app/api/auth/login/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { username, password } = await request.json();

    if (!username || !password) {
      return NextResponse.json({ error: "Username and password required" }, { status: 400 });
    }

    const formData = new URLSearchParams({
      grant_type: 'password',
      username: username,
      password: password,
      client_id: process.env.TASTYTRADE_CLIENT_ID || '',
      client_secret: process.env.TASTYTRADE_CLIENT_SECRET || '',
    });

    const res = await fetch('https://api.tastytrade.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json({ 
        error: data.error_description || data.error || "Login failed" 
      }, { status: res.status });
    }

    return NextResponse.json({
      access_token: data.access_token,
      expires_in: data.expires_in,
    });

  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}