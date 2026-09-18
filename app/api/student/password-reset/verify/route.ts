import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import { supabase } from '../../../../../lib/supabase';
import { normalizeStudentIdentifier } from '../../../../../lib/studentData';

export const dynamic = 'force-dynamic';

const normalize = (value: unknown) => String(value ?? '').trim();
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

export async function POST(request: Request) {
  let stage = 'start';
  try {
    stage = 'parse-request';
    const body = await request.json() as { identifier?: string; code?: string; newPassword?: string };
    const identifier = normalize(body.identifier);
    const normalizedIdentifier = normalizeStudentIdentifier(identifier);
    const code = normalize(body.code);
    const newPassword = normalize(body.newPassword);
    if (!identifier || !/^\d{6}$/.test(code) || newPassword.length < 8) {
      return NextResponse.json({ success: false, error: 'invalid-reset-input' }, { status: 400 });
    }

    stage = 'find-student';
    const { data: students, error: studentsError } = await supabase.from('students').select('*');
    if (studentsError) {
      console.error('RESET_PASSWORD_ERROR:', { stage, code: studentsError.code, message: studentsError.message, details: studentsError.details, hint: studentsError.hint });
      return NextResponse.json({ success: false, error: 'student-query-failed' }, { status: 500 });
    }
    const student = (Array.isArray(students) ? students : []).find((row) => {
      const record = row as Record<string, unknown>;
      return [record['الرقم الجامعي'], record.student_id, record.studentId]
        .some((value) => normalizeStudentIdentifier(value) === normalizedIdentifier)
        || [record['رقم الهاتف'], record.phone].some((value) => normalize(value) === identifier);
    }) as Record<string, unknown> | undefined;
    if (!student) return NextResponse.json({ success: false, error: 'student-not-found' }, { status: 404 });

    const studentId = normalize(student['الرقم الجامعي'] ?? student.student_id ?? student.studentId ?? student.id);
    stage = 'read-reset-code';
    const { data: resetRows, error: resetError } = await supabase
      .from('password_reset_codes')
      .select('*')
      .eq('student_id', studentId)
      .is('used_at', null)
      .order('created_at', { ascending: false })
      .limit(1);
    if (resetError) {
      console.error('RESET_PASSWORD_ERROR:', { stage, code: resetError.code, message: resetError.message, details: resetError.details, hint: resetError.hint });
      return NextResponse.json({ success: false, error: 'password-reset-table-missing' }, { status: 500 });
    }

    const resetRow = Array.isArray(resetRows) ? resetRows[0] as Record<string, unknown> | undefined : undefined;
    if (!resetRow || new Date(String(resetRow.expires_at)).getTime() < Date.now()) {
      return NextResponse.json({ success: false, error: 'code-expired' }, { status: 400 });
    }

    const attempts = Number(resetRow.attempts ?? 0);
    if (attempts >= 5) return NextResponse.json({ success: false, error: 'too-many-attempts' }, { status: 429 });

    const resetId = resetRow.id;
    if (String(resetRow.code_hash) !== hashCode(code)) {
      await supabase.from('password_reset_codes').update({ attempts: attempts + 1 }).eq('id', resetId);
      return NextResponse.json({ success: false, error: 'invalid-code' }, { status: 400 });
    }

    const passwordPayload = { 'كلمة السر': newPassword, password: newPassword };
    stage = 'update-password';
    const update = await supabase.from('students').update(passwordPayload).eq('الرقم الجامعي', studentId);
    if (update.error) {
      const fallback = await supabase.from('students').update({ 'كلمة السر': newPassword }).eq('id', studentId);
      if (fallback.error) throw fallback.error;
    }

    await supabase.from('password_reset_codes').update({ used_at: new Date().toISOString() }).eq('id', resetId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('RESET_PASSWORD_ERROR:', { stage, error });
    return NextResponse.json({ success: false, error: 'password-reset-failed' }, { status: 500 });
  }
}
