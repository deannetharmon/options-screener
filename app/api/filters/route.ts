import Redis from 'ioredis';
import { NextResponse } from 'next/server';

function getRedis() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL not configured');
  return new Redis(url);
}

export async function GET(request: Request) {
  let redis;
  try {
    const { searchParams } = new URL(request.url);
    const strategy = searchParams.get('strategy');
    if (!strategy) return NextResponse.json({ error: 'strategy required' }, { status: 400 });
    redis = getRedis();
    const raw = await redis.get(`filters:${strategy}`);
    const filters = raw ? JSON.parse(raw) : {};
    return NextResponse.json({ filters });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  } finally {
    redis?.disconnect();
  }
}

export async function POST(request: Request) {
  let redis;
  try {
    const { strategy, name, tickers, bps, bcs, ic, replace } = await request.json();
    if (!strategy || !name) return NextResponse.json({ error: 'strategy and name required' }, { status: 400 });
    redis = getRedis();
    const raw = await redis.get(`filters:${strategy}`);
    const existing: Record<string, any> = raw ? JSON.parse(raw) : {};
    if (existing[name] && !replace) {
      return NextResponse.json({ conflict: true, message: `"${name}" already exists` });
    }
    existing[name] = strategy === 'global' ? { bps: bps ?? [], bcs: bcs ?? [], ic: ic ?? [] } : tickers;
    await redis.set(`filters:${strategy}`, JSON.stringify(existing));
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  } finally {
    redis?.disconnect();
  }
}

export async function DELETE(request: Request) {
  let redis;
  try {
    const { strategy, name } = await request.json();
    if (!strategy || !name) return NextResponse.json({ error: 'strategy and name required' }, { status: 400 });
    redis = getRedis();
    const raw = await redis.get(`filters:${strategy}`);
    const existing: Record<string, any> = raw ? JSON.parse(raw) : {};
    delete existing[name];
    await redis.set(`filters:${strategy}`, JSON.stringify(existing));
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  } finally {
    redis?.disconnect();
  }
}
