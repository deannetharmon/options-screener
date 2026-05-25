// app/api/analyze/route.ts
// Server-side proxy for OpenAI API.
// Reads NEXT_PUBLIC_OPENAI_API_KEY from environment (or add OPENAI_API_KEY as a private var).

import { NextRequest, NextResponse } from 'next/server';

const OPENAI_API = 'https://api.openai.com/v1/chat/completions';

export async function POST(req: NextRequest) {
  // Support both the public var you already have and a private one
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.NEXT_PUBLIC_OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Convert Anthropic-style request body to OpenAI format
  const messages = [];
  if (body.system) {
    messages.push({ role: 'system', content: body.system });
  }
  for (const m of body.messages ?? []) {
    messages.push({ role: m.role, content: m.content });
  }

  try {
    const res = await fetch(OPENAI_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: body.max_tokens ?? 1000,
        messages,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(
        { error: data?.error?.message ?? `OpenAI error ${res.status}` },
        { status: res.status }
      );
    }

    // Translate OpenAI response back to Anthropic shape so callAI() needs no changes
    const text = data?.choices?.[0]?.message?.content ?? '';
    return NextResponse.json({
      content: [{ type: 'text', text }],
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Proxy fetch failed' }, { status: 502 });
  }
}
