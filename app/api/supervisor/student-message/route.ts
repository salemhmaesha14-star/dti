import { NextResponse } from 'next/server';
import { sendEmail } from '../../../../lib/email';

export const dynamic = 'force-dynamic';

const normalize = (value: unknown) => String(value ?? '').trim();
const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      email?: string;
      studentName?: string;
      studentId?: string;
      studentYear?: string;
      studentClass?: string;
      message?: string;
    };
    const email = normalize(body.email);
    const studentName = normalize(body.studentName) || 'الطالب';
    const message = normalize(body.message);

    if (!email || !message) {
      return NextResponse.json({ success: false, error: 'missing-email-or-message' }, { status: 400 });
    }

    const safeName = escapeHtml(studentName);
    const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');
    const result = await sendEmail({
      to: email,
      subject: 'نظام الإدارة',
      html: `<div dir="rtl" style="margin:0;background:#f5f8f6;padding:28px 12px;font-family:Arial,Tahoma,sans-serif;color:#24352f">
        <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #dce9e3;border-radius:14px;overflow:hidden">
          <div style="padding:22px;background:#28594e;color:#fff;text-align:center"><h2 style="margin:0;font-size:21px">نظام الإدارة</h2><p style="margin:7px 0 0;color:#dcefe8">المعهد التقاني لطب الأسنان</p></div>
          <div style="padding:26px 22px;line-height:1.9"><p style="margin-top:0">مرحبًا ${safeName}،</p><p>${safeMessage}</p><hr style="border:0;border-top:1px solid #e5eee9;margin:22px 0"><p style="margin:0;color:#6b7d76;font-size:13px">الرقم الجامعي: ${escapeHtml(normalize(body.studentId) || 'غير محدد')}<br>السنة: ${escapeHtml(normalize(body.studentYear) || 'غير محددة')}<br>الفئة: ${escapeHtml(normalize(body.studentClass) || 'غير محددة')}</p></div>
          <div style="padding:14px 22px;background:#f5f8f6;color:#71827b;text-align:center;font-size:12px">هذه رسالة آلية من بوابة المعهد.</div>
        </div>
      </div>`,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 502 });
  } catch (error) {
    console.error('Supervisor student email failed:', error);
    return NextResponse.json({ success: false, error: 'student-email-send-failed' }, { status: 500 });
  }
}