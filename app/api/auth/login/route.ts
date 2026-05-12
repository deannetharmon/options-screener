// app/api/auth/login/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { username, password } = await request.json();

    if (!username || !password) {
      return NextResponse.json({ error: "Username and password are required" }, { status: 400 });
    }

    console.log("🔑 Attempting login for:", username);

    if (!process.env.TASTYTRADE_CLIENT_ID || !process.env.TASTYTRADE_CLIENT_SECRET) {
      console.error("❌ Missing TastyTrade Client ID or Secret in environment variables");
      return NextResponse.json({ error: "Server configuration error - missing credentials" }, { status: 500 });
    }

    const formData = new URLSearchParams({
      grant_type: 'password',
      username,
      password,
      client_id: process.env.TASTYTRADE_CLIENT_ID,
      client_secret: process.env.TASTYTRADE_CLIENT_SECRET,
    });

    const res = await fetch('https://api.tastytrade.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData,
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("TastyTrade API Error:", data);
      return NextResponse.json({ 
        error: data.error_description || data.error || "Invalid username or password" 
      }, { status: res.status });
    }

    console.log("✅ Login successful");
    return NextResponse.json({
      access_token: data.access_token,
    });

  } catch (error: any) {
    console.error("Login route error:", error);
    return NextResponse.json({ error: "Internal server error: " + error.message }, { status: 500 });
  }
}