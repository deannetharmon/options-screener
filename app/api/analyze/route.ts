// app/api/analyze/route.ts
// Server-side proxy for Anthropic API — avoids CORS from the browser.
// Set ANTHROPIC_API_KEY in your Vercel environment variables.

import { NextRequest, NextResponse } from 'next/server';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(
        { error: data?.error?.message ?? `Anthropic error ${res.status}` },
        { status: res.status }
      );
    }

    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Proxy fetch failed' }, { status: 502 });
  }
}
