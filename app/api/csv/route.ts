import { NextRequest, NextResponse } from 'next/server';
import { parseBarchartCSV, filterBarchartRows } from '@/lib/csvParser';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const text = await file.text();
    const parsed = parseBarchartCSV(text);

    // Get filter params from form data
    const minIVR = parseFloat(formData.get('minIVR') as string || '30');
    const minIVx = parseFloat(formData.get('minIVx') as string || '35');
    const minPrice = parseFloat(formData.get('minPrice') as string || '50');
    const minOptVol = parseFloat(formData.get('minOptVol') as string || '10000');

    const filtered = filterBarchartRows(parsed, { minIVR, minIVx, minPrice, minOptVol });

    return NextResponse.json({
      total: parsed.length,
      filtered: filtered.length,
      rows: filtered,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to parse CSV' }, { status: 500 });
  }
}
