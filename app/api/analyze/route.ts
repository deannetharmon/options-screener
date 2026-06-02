// app/api/analyze/route.ts
// Server-side proxy for OpenAI API with web search support.
import { NextRequest, NextResponse } from 'next/server';

const OPENAI_API = 'https://api.openai.com/v1/chat/completions';
const OPENAI_RESPONSES_API = 'https://api.openai.com/v1/responses';

export async function POST(req: NextRequest) {
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

  // If web_search is requested, use the Responses API with gpt-4o-search-preview
  const wantsSearch = body.web_search === true;

  if (wantsSearch) {
    return handleWithSearch(body, apiKey);
  }

  return handleStandard(body, apiKey);
}

// ── Standard chat completions (existing behavior) ──────────────────────────
async function handleStandard(body: any, apiKey: string) {
  const messages: any[] = [];
  if (body.system) messages.push({ role: 'system', content: body.system });
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
    const text = data?.choices?.[0]?.message?.content ?? '';
    return NextResponse.json({ content: [{ type: 'text', text }] });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Proxy fetch failed' }, { status: 502 });
  }
}

// ── Web search via Responses API ───────────────────────────────────────────
async function handleWithSearch(body: any, apiKey: string) {
  // Build input array for Responses API
  const input: any[] = [];

  // Add conversation history as user/assistant turns
  for (const m of body.messages ?? []) {
    if (m.role === 'user') {
      // Support multipart content (text + images)
      if (Array.isArray(m.content)) {
        input.push({ role: 'user', content: m.content });
      } else {
        input.push({ role: 'user', content: m.content });
      }
    } else if (m.role === 'assistant') {
      input.push({ role: 'assistant', content: typeof m.content === 'string' ? m.content : m.content?.find((p: any) => p.type === 'text')?.text ?? '' });
    }
  }

  try {
    const res = await fetch(OPENAI_RESPONSES_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-search-preview',
        tools: [{ type: 'web_search_preview' }],
        instructions: body.system ?? '',
        input,
        max_output_tokens: body.max_tokens ?? 1000,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json(
        { error: data?.error?.message ?? `OpenAI search error ${res.status}` },
        { status: res.status }
      );
    }

    // Extract text from Responses API output array
    const outputItems: any[] = data?.output ?? [];
    const text = outputItems
      .filter((item: any) => item.type === 'message')
      .flatMap((item: any) => item.content ?? [])
      .filter((c: any) => c.type === 'output_text')
      .map((c: any) => c.text)
      .join('');

    return NextResponse.json({ content: [{ type: 'text', text }] });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Search proxy failed' }, { status: 502 });
  }
}
