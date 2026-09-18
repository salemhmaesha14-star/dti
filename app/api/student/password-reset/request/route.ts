import { createHash, randomInt } from 'crypto';
import { NextResponse } from 'next/server';
import { supabase } from '../../../../../lib/supabase';
import { sendEmail } from '../../../../../lib/email';
import { buildStudentTelegramMessage, sendTelegramNotification } from '../../../../../lib/telegram';
import { normalizeStudentIdentifier } from '../../../../../lib/studentData';

export const dynamic = 'force-dynamic';

const normalize = (value: unknown) => String(value ?? '').trim();
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');
const maskEmail = (email: string) => {
  const [name, domain] = email.split('@');
  if (!name || !domain) return 'البريد الإلكتروني المرتبط';
  return `${name.slice(0, 2)}***@${domain}`;
};

export async function POST(request: Request) {
  let stage = 'start';
  try {
    stage = 'parse-request';
    const body = await request.json() as { identifier?: string; method?: 'telegram' | 'email' };
    const identifier = normalize(body.identifier);
    const normalizedIdentifier = normalizeStudentIdentifier(identifier);
    if (!identifier) return NextResponse.json({ success: false, error: 'missing-identifier' }, { status: 400 });

    stage = 'find-student';
    const { data, error } = await supabase.from('students').select('*');
    if (error) {
      console.error('RESET_PASSWORD_ERROR:', { stage, code: error.code, message: error.message, details: error.details, hint: error.hint });
      return NextResponse.json({ success: false, error: 'student-query-failed' }, { status: 500 });
    }

    const student = (Array.isArray(data) ? data : []).find((row) => {
      const record = row as Record<string, unknown>;
      return [record['الرقم الجامعي'], record.student_id, record.studentId]
        .some((value) => normalizeStudentIdentifier(value) === normalizedIdentifier)
        || [record['رقم الهاتف'], record.phone].some((value) => normalize(value) === identifier);
    }) as Record<string, unknown> | undefined;

    if (!student) return NextResponse.json({ success: false, error: 'student-not-found' }, { status: 404 });

    const email = normalize(student['البريد الإلكتروني'] ?? student.email);
    const chatId = normalize(student.telegram_chat_id ?? student['telegram_chat_id']);
    const enabledValue = student.telegram_notifications_enabled ?? student['telegram_notifications_enabled'];
    const telegramEnabled = enabledValue === true || ['true', '1', 'yes'].includes(normalize(enabledValue).toLowerCase());
    const methods = [
      ...(telegramEnabled && chatId ? ['telegram' as const] : []),
      ...(email ? ['email' as const] : []),
    ];

    if (!methods.length) return NextResponse.json({ success: false, error: 'no-recovery-method' }, { status: 400 });

    if (!body.method && methods.length > 1) {
      return NextResponse.json({ success: true, methods, requiresMethod: true });
    }

    const method = methods.includes(body.method as 'telegram' | 'email') ? body.method : methods[0];
    const code = String(randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const studentId = normalize(student['الرقم الجامعي'] ?? student.student_id ?? student.studentId ?? student.id);

    stage = 'save-reset-code';
    const { error: saveError } = await supabase.from('password_reset_codes').insert([{
      student_id: studentId,
      code_hash: hashCode(code),
      expires_at: expiresAt,
      attempts: 0,
      used_at: null,
    }]);
    if (saveError) {
      console.error('RESET_PASSWORD_ERROR:', { stage, code: saveError.code, message: saveError.message, details: saveError.details, hint: saveError.hint });
      const tableMissing = saveError.code === '42P01' || saveError.code === 'PGRST205' || saveError.message.toLowerCase().includes('password_reset_codes');
      return NextResponse.json({ success: false, error: tableMissing ? 'password-reset-table-missing' : 'reset-code-save-failed' }, { status: 500 });
    }

    const studentName = normalize(student['اسم الطالب'] ?? student.name) || 'الطالب';
    let sent = false;
    stage = method === 'telegram' ? 'send-telegram-code' : 'send-email-code';
    if (method === 'telegram' && chatId) {
      const message = buildStudentTelegramMessage({
        studentName,
        studentId,
        studentYear: normalize(student['السنه الدراسية'] ?? student['السنة الدراسية']) || 'غير محدد',
        studentClass: normalize(student['الفئة']) || 'غير محددة',
        statusText: `رمز استعادة كلمة المرور الخاص بك هو: ${code}\nصالح لمدة 10 دقائق.`,
        title: 'استعادة كلمة المرور',
      });
      const result = await sendTelegramNotification(message, { chatId, enabled: true });
      sent = result?.ok === true;
    } else if (method === 'email' && email) {
      const result = await sendEmail({
        to: email,
        subject: 'رمز استعادة كلمة المرور',
        html: `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8"><h2>استعادة كلمة المرور</h2><p>مرحبًا ${studentName}،</p><p>رمز التحقق الخاص بك هو:</p><div style="font-size:30px;font-weight:800;letter-spacing:8px;color:#0f766e">${code}</div><p>الرمز صالح لمدة 10 دقائق.</p></div>`,
      });
      sent = result.success;
    }

    if (!sent) return NextResponse.json({ success: false, error: 'code-send-failed' }, { status: 502 });
    return NextResponse.json({ success: true, method, methods, destination: method === 'email' ? maskEmail(email) : 'حساب التليجرام المرتبط' });
  } catch (error) {
    console.error('RESET_PASSWORD_ERROR:', { stage, error });
    return NextResponse.json({ success: false, error: 'password-reset-request-failed' }, { status: 500 });
  }
}
