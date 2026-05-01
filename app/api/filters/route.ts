import { kv } from '@vercel/kv';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const strategy = searchParams.get('strategy');
  if (!strategy) return NextResponse.json({ error: 'strategy required' }, { status: 400 });

  const filters = await kv.get(`filters:${strategy}`) as Record<string, string[]> | null;
  return NextResponse.json({ filters: filters ?? {} });
}

export async function POST(request: Request) {
  const { strategy, name, tickers, replace } = await request.json();
  if (!strategy || !name || !tickers) return NextResponse.json({ error: 'strategy, name, tickers required' }, { status: 400 });

  const existing = await kv.get(`filters:${strategy}`) as Record<string, string[]> | null ?? {};
  
  if (existing[name] && !replace) {
    return NextResponse.json({ conflict: true, message: `"${name}" already exists` });
  }

  existing[name] = tickers;
  await kv.set(`filters:${strategy}`, existing);
  return NextResponse.json({ success: true });
}

export async function DELETE(request: Request) {
  const { strategy, name } = await request.json();
  if (!strategy || !name) return NextResponse.json({ error: 'strategy and name required' }, { status: 400 });

  const existing = await kv.get(`filters:${strategy}`) as Record<string, string[]> | null ?? {};
  delete existing[name];
  await kv.set(`filters:${strategy}`, existing);
  return NextResponse.json({ success: true });
}
