import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    console.log('Telegram update received:', JSON.stringify(body));

    const chatId = body?.message?.chat?.id;
    const text = body?.message?.text;

    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

    if (!token) {
      console.error('Telegram webhook rejected: TELEGRAM_BOT_TOKEN is not configured.');
      return NextResponse.json({ ok: false, error: 'Telegram bot token is not configured' }, { status: 500 });
    }

    if (chatId) {
      const responseText = text === '/start' 
        ? `أهلاً بك! الـ Chat ID الخاص بك هو: \`${chatId}\``
        : `تم استقبال رسالتك. الـ Chat ID الخاص بك: \`${chatId}\``;

      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: responseText,
          parse_mode: 'Markdown',
        }),
      });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error('Error handling telegram webhook:', error);
    return NextResponse.json({ ok: true }, { status: 200 });
  }
}
