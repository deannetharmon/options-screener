import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { base64, mediaType } = await req.json();

    if (!base64 || !mediaType) {
      return NextResponse.json({ error: 'Missing base64 or mediaType' }, { status: 400 });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${mediaType};base64,${base64}`,
                detail: 'low',
              },
            },
            {
              type: 'text',
              text: `This is a screenshot containing US stock ticker symbols. Extract every ticker symbol you can see.

Rules:
- Return ONLY the ticker symbols, one per line, nothing else
- Tickers are 2-5 uppercase letters (e.g. AAPL, MSFT, BRK-B)
- Do NOT include: single letters, common words, UI labels, column headers, numbers, percentages
- Do NOT include: ETF, BPS, BCS, IC, IVR, DTE, ROC, POP, NYSE, NASDAQ, or any other non-ticker text
- Preserve hyphens for tickers like BRK-B
- If you are uncertain whether something is a ticker, omit it
- Return nothing except the ticker symbols, one per line`,
            },
          ],
        }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return NextResponse.json(
        { error: `OpenAI error: ${response.status} — ${err?.error?.message ?? 'unknown'}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    const text: string = data?.choices?.[0]?.message?.content ?? '';
    return NextResponse.json({ text });

  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Internal error' }, { status: 500 });
  }
}

