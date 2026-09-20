import { NextResponse } from 'next/server';
import { supabase } from '../../../../lib/supabase';
import { normalizeStudentIdentifier } from '../../../../lib/studentData';

export const dynamic = 'force-dynamic';

const normalize = (value: unknown) => String(value ?? '').trim();
const errorResponse = (error: string, status: number, details?: string) => NextResponse.json({
  success: false,
  error,
  ...(details ? { details } : {}),
}, { status });

const isMissingTableError = (error: { message?: string }) => {
  const message = String(error.message ?? '').toLowerCase();
  return message.includes('does not exist') || message.includes('relation') || message.includes('not found');
};

export async function GET(request: Request) {
  const studentId = normalizeStudentIdentifier(new URL(request.url).searchParams.get('studentId'));
  if (!studentId) return errorResponse('missing-student-id', 400, 'الرقم الجامعي غير موجود.');

  const { data, error } = await supabase
    .from('student_id_change_requests')
    .select('id')
    .or(`student_id.eq.${studentId},new_university_id.eq.${studentId}`)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('STUDENT_ID_CHANGE_ERROR:', error);
    return errorResponse('student-id-change-status-failed', 500, error.message);
  }

  return NextResponse.json({ success: true, used: Boolean(data) });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      currentStudentId?: string;
      newStudentId?: string;
      confirmed?: boolean;
    };
    const currentStudentId = normalizeStudentIdentifier(body.currentStudentId);
    const newStudentId = normalizeStudentIdentifier(body.newStudentId);

    if (!currentStudentId || !newStudentId) {
      return errorResponse('missing-student-id', 400, 'أدخل الرقم الجامعي الحالي والرقم الجامعي الجديد.');
    }
    if (currentStudentId === newStudentId) {
      return errorResponse('same-student-id', 400, 'الرقم الجامعي الجديد مطابق للرقم الحالي.');
    }
    if (body.confirmed !== true) {
      return errorResponse('confirmation-required', 400, 'يجب تأكيد مطابقة الرقم للقوائم المنشورة وتحمل مسؤولية إدخاله.');
    }

    const { data: students, error: studentsError } = await supabase.from('students').select('*');
    if (studentsError) {
      console.error('STUDENT_ID_CHANGE_ERROR:', studentsError);
      return errorResponse('student-query-failed', 500, studentsError.message);
    }

    const studentRows = (Array.isArray(students) ? students : []) as Record<string, unknown>[];
    const student = studentRows.find((row) => normalizeStudentIdentifier(
      row['الرقم الجامعي'] ?? row.student_id ?? row.studentId ?? row.id
    ) === currentStudentId);
    if (!student) return errorResponse('student-not-found', 404, 'لم يتم العثور على حساب الطالب الحالي.');

    const duplicateStudent = studentRows.find((row) => normalizeStudentIdentifier(
      row['الرقم الجامعي'] ?? row.student_id ?? row.studentId ?? row.id
    ) === newStudentId);
    if (duplicateStudent) return errorResponse('student-id-already-used', 409, 'الرقم الجامعي الجديد مرتبط بحساب آخر.');

    const { data: existingChange, error: existingChangeError } = await supabase
      .from('student_id_change_requests')
      .select('id')
      .eq('student_id', currentStudentId)
      .maybeSingle();
    if (existingChangeError && !existingChangeError.message.toLowerCase().includes('does not exist')) {
      console.error('STUDENT_ID_CHANGE_ERROR:', existingChangeError);
      return errorResponse('student-id-change-check-failed', 500, existingChangeError.message);
    }
    if (existingChange) return errorResponse('student-id-change-already-used', 409, 'يمكن تغيير الرقم الجامعي مرة واحدة فقط.');

    const { error: recordError } = await supabase.from('student_id_change_requests').insert([{
      student_id: currentStudentId,
      old_university_id: currentStudentId,
      new_university_id: newStudentId,
    }]);
    if (recordError) {
      console.error('STUDENT_ID_CHANGE_ERROR:', recordError);
      if (recordError.code === '23505') return errorResponse('student-id-change-already-used', 409, 'يمكن تغيير الرقم الجامعي مرة واحدة فقط.');
      return errorResponse('student-id-change-record-failed', 500, recordError.message);
    }

    const studentIdKey = student['الرقم الجامعي'] !== undefined
      ? 'الرقم الجامعي'
      : student.student_id !== undefined
        ? 'student_id'
        : student.studentId !== undefined
          ? 'studentId'
          : 'id';
    const { error: updateError } = await supabase
      .from('students')
      .update({ 'الرقم الجامعي': newStudentId })
      .eq(studentIdKey, student[studentIdKey]);

    if (updateError) {
      await supabase.from('student_id_change_requests').delete().eq('student_id', currentStudentId);
      console.error('STUDENT_ID_CHANGE_ERROR:', updateError);
      return errorResponse('student-id-update-failed', 500, updateError.message);
    }

    const updatedRelatedTables: string[] = [];
    for (const tableName of ['الحضور', 'الإنذارات']) {
      const { error: relatedUpdateError } = await supabase
        .from(tableName)
        .update({ 'الرقم الجامعي': newStudentId })
        .eq('الرقم الجامعي', currentStudentId);

      if (!relatedUpdateError) {
        updatedRelatedTables.push(tableName);
        continue;
      }

      if (isMissingTableError(relatedUpdateError)) continue;

      for (const updatedTable of updatedRelatedTables) {
        await supabase.from(updatedTable).update({ 'الرقم الجامعي': currentStudentId }).eq('الرقم الجامعي', newStudentId);
      }
      await supabase.from('students').update({ 'الرقم الجامعي': currentStudentId }).eq(studentIdKey, student[studentIdKey]);
      await supabase.from('student_id_change_requests').delete().eq('student_id', currentStudentId);
      console.error('STUDENT_ID_CHANGE_ERROR:', relatedUpdateError);
      return errorResponse('related-records-update-failed', 500, `تعذر تحديث جدول ${tableName}: ${relatedUpdateError.message}`);
    }

    return NextResponse.json({ success: true, studentId: newStudentId });
  } catch (error) {
    console.error('STUDENT_ID_CHANGE_ERROR:', error);
    return errorResponse('student-id-change-failed', 500, error instanceof Error ? error.message : String(error));
  }
}