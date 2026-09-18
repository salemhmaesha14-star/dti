import { NextResponse } from 'next/server';
import { buildClassChangeEmail, sendEmail } from '../../../../lib/email';
import { buildStudentTelegramMessage, sendTelegramNotification } from '../../../../lib/telegram';
import { getStudentById, updateStudentClass, getRecordValue } from '../../../../lib/studentData';

export const dynamic = 'force-dynamic';

type ClassChangeRequest = {
  studentId?: string;
  nextClass?: string;
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as ClassChangeRequest;
    const studentId = String(body.studentId ?? '').trim();
    const nextClass = String(body.nextClass ?? '').trim();

    if (!studentId || !nextClass) {
      return NextResponse.json({ success: false, error: 'missing-class-or-student' }, { status: 400 });
    }

    const student = await getStudentById(studentId);
    if (!student) {
      return NextResponse.json({ success: false, error: 'student-not-found' }, { status: 404 });
    }

    const previousClass = String(student['الفئة'] ?? '').trim();
    const result = await updateStudentClass(studentId, nextClass);
    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }

    const studentName = String(getRecordValue(student as Record<string, unknown>, ['اسم الطالب', 'student_name', 'name']) ?? 'الطالب');
    const email = String(getRecordValue(student as Record<string, unknown>, ['البريد الإلكتروني', 'email']) ?? '').trim();
    const emailResult = email
      ? await sendEmail({
        to: email,
        subject: 'تغيير الفئة',
        html: buildClassChangeEmail({ studentName, previousClass, nextClass }),
      })
      : { success: false, error: 'student-email-missing' };

    const notificationsEnabled = Boolean(student.telegram_notifications_enabled ?? student['telegram_notifications_enabled']);
    const chatId = String(student.telegram_chat_id ?? student['telegram_chat_id'] ?? '').trim();
    let telegramResult: { ok?: boolean; status?: string } = { status: 'disabled_or_missing_chat_id' };

    if (notificationsEnabled && chatId) {
      const telegramMessage = buildStudentTelegramMessage({
        studentName,
        studentId,
        studentYear: String(student['السنه الدراسية'] ?? 'غير محدد'),
        studentClass: nextClass,
        statusText: `تم تغيير الفئة بنجاح من ${previousClass || 'غير محددة'} إلى ${nextClass}.`,
        title: 'تغيير الفئة',
      });
      telegramResult = await sendTelegramNotification(telegramMessage, { chatId, enabled: true });
    }

    return NextResponse.json({ success: true, emailSent: emailResult.success, telegramSent: telegramResult.ok === true });
  } catch (error) {
    console.error('Class change API failed:', error);
    return NextResponse.json({ success: false, error: 'class-change-failed' }, { status: 500 });
  }
}
