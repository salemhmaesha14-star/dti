'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { writeAuditLog } from '../lib/auditLog';
import {
  getAttendanceForStudent,
  getClassAvailabilityOptions,
  getStudentById,
  getWarningsForStudent,
  getRecordValue,
  normalizeText,
  StudentRow,
  updateStudentClass,
} from '../lib/studentData';
import { buildStudentTelegramMessage, sendTelegramNotification } from '../lib/telegram';

type TabKey = 'grades' | 'record' | 'status';

type GradeEntry = {
  subject: string;
  annual: number | null;
  theory: number | null;
  practical: number | null;
  total: number | null;
  assistance: string;
};

const studentSessionStorageKey = 'udti-student-session';

const metadataKeys = new Set([
  'id',
  'الرقم الجامعي',
  'كلمة السر',
  'اسم الطالب',
  'اسم الاب',
  'الكنية',
  'القسم',
  'رقم الهاتف',
  'نوع التسجيل',
  'ملاحظة',
  'البريد الإلكتروني',
  'الفئة',
  'تاريخ_تغيير_الفئة',
  'تاريخ الإنشاء',
  'السنه الدراسية',
  'created_at',
  'updated_at',
  'createdAt',
  'updatedAt',
]);

const formatStudentValue = (value: string | number | null | undefined) => {
  if (value === null || value === undefined || value === '') return 'غير متوفر';
  return String(value);
};

const formatDate = (value: string | null | undefined) => {
  if (!value) return 'غير متوفر';

  try {
    return new Date(value).toLocaleDateString('ar-EG', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return String(value);
  }
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/,/g, '').replace(/[^0-9.-]/g, '');
    if (!cleaned || cleaned === '-' || cleaned === '.') return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const getValueByKeys = (row: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return undefined;
};

const extractGrades = (rows: Record<string, unknown>[]): GradeEntry[] => {
  if (!rows.length) return [];

  const first = rows[0];
  const gradeRows: GradeEntry[] = [];

  Object.entries(first).forEach(([key, value]) => {
    if (metadataKeys.has(key)) return;
    if (value === null || value === undefined || value === '') return;

    const parsed = toNumber(value);
    if (parsed === null) return;

    gradeRows.push({
      subject: key,
      annual: parsed,
      theory: null,
      practical: null,
      total: parsed,
      assistance: parsed >= 50 ? 'مقبول' : 'غير مقبول',
    });
  });

  if (gradeRows.length) return gradeRows;

  return rows.flatMap((row) => {
    return Object.entries(row)
      .filter(([key, value]) => !metadataKeys.has(key) && value !== null && value !== undefined && value !== '')
      .map(([subject, value]) => {
        const numeric = toNumber(value);
        return {
          subject,
          annual: numeric,
          theory: null,
          practical: null,
          total: numeric,
          assistance: numeric !== null && numeric >= 50 ? 'مقبول' : 'غير مقبول',
        };
      });
  });
};

const parseAttendance = (rows: Record<string, unknown>[]) => {
  const summary = { present: 0, absent: 0 };

  rows.forEach((row) => {
    const status = getValueByKeys(row, ['الحضور', 'حضور', 'status', 'الحالة', 'attendance']) as string | number | boolean | undefined;
    const normalized = String(status ?? '').trim().toLowerCase();

    if (status === true || normalized === 'حاضر' || normalized === 'present' || normalized === '1' || normalized === 'yes') {
      summary.present += 1;
    } else if (status === false || normalized === 'غائب' || normalized === 'absent' || normalized === '0' || normalized === 'no') {
      summary.absent += 1;
    }
  });

  return [
    { label: 'حاضر', value: String(summary.present), tone: 'present' },
    { label: 'غائب', value: String(summary.absent), tone: 'absent' },
  ];
};

const getTableRows = async (tableNames: string[], select = '*') => {
  for (const tableName of tableNames) {
    const { data, error } = await supabase.from(tableName).select(select).limit(1);
    if (!error) return { data: data ?? [], tableName };
    const message = String(error.message || '');
    if (message.includes('does not exist') || message.includes('not found') || message.includes('relation')) {
      continue;
    }
    return { data: data ?? [], tableName, error };
  }

  return { data: [], tableName: tableNames[0], error: null };
};

export default function Home() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('record');
  const [notice, setNotice] = useState('يرجى تسجيل الدخول لعرض نتائجك');
  const [loginData, setLoginData] = useState({ studentId: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [loggedStudent, setLoggedStudent] = useState<StudentRow | null>(null);
  const [grades, setGrades] = useState<GradeEntry[]>([]);
  const [warnings, setWarnings] = useState<Record<string, unknown>[]>([]);
  const [attendanceSummary, setAttendanceSummary] = useState([
    { label: 'حاضر', value: '0', tone: 'present' },
    { label: 'غائب', value: '0', tone: 'absent' },
  ]);
  const [studentStatus, setStudentStatus] = useState<string>('غير متوفر');
  const [classOptions, setClassOptions] = useState<Array<{ name: string; capacity: number | null; occupied: number; available: number | null }>>([]);
  const [selectedClassForUpdate, setSelectedClassForUpdate] = useState('');
  const [isChangingClass, setIsChangingClass] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [telegramNotificationsEnabled, setTelegramNotificationsEnabled] = useState(false);
  const [showTelegramSettingsModal, setShowTelegramSettingsModal] = useState(false);
  const [telegramChatIdInput, setTelegramChatIdInput] = useState('');
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  const getStudentTelegramChatId = (student: any) => {
    const value = student?.telegram_chat_id ?? student?.['telegram_chat_id'];
    if (value === undefined || value === null) return '';
    return String(value).trim();
  };

  const isTelegramEnabled = (value: any): boolean => {
    if (value === undefined || value === null) return false;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === 'yes' || normalized === '1';
    }
    return Boolean(value);
  };

  const getStudentTelegramPreference = (student: StudentRow | null | undefined) => {
    const chatId = getStudentTelegramChatId(student);
    const value = student?.telegram_notifications_enabled ?? student?.['telegram_notifications_enabled'];
    return !!chatId && isTelegramEnabled(value);
  };

  const persistTelegramPreference = async (enabled: boolean, nextChatId?: string) => {
    const studentId = String(loggedStudent?.['الرقم الجامعي'] ?? '').trim();
    if (!studentId) return;

    try {
      const payload: Record<string, unknown> = {
        telegram_notifications_enabled: enabled,
      };
      if (nextChatId !== undefined) {
        payload.telegram_chat_id = nextChatId.trim() || null;
      }

      const { error } = await supabase.from('students').update(payload).eq('الرقم الجامعي', studentId);
      if (!error) {
        const hydratedStudent = {
          ...(loggedStudent ?? {}),
          telegram_notifications_enabled: enabled,
          telegram_chat_id: nextChatId !== undefined ? (nextChatId.trim() || null) : (loggedStudent?.telegram_chat_id ?? loggedStudent?.['telegram_chat_id'] ?? null),
        } as StudentRow;

        setLoggedStudent(hydratedStudent);
        setTelegramNotificationsEnabled(enabled);
        window.localStorage.setItem(studentSessionStorageKey, JSON.stringify(hydratedStudent));
      }
    } catch {
      // Ignore DB column mismatch; keep local UI state for active session.
    }
  };

  const handleTelegramToggle = async () => {
    if (telegramNotificationsEnabled) {
      const studentId = String(loggedStudent?.['الرقم الجامعي'] ?? '').trim();
      if (!studentId) return;

      try {
        const { error } = await supabase.from('students').update({ telegram_notifications_enabled: false }).eq('الرقم الجامعي', studentId);
        if (!error) {
          setTelegramNotificationsEnabled(false);
          setLoggedStudent((previous) => (previous ? { ...previous, telegram_notifications_enabled: false } : previous));
        }
      } catch {
        setTelegramNotificationsEnabled(false);
      }
      return;
    }

    const currentChatId = getStudentTelegramChatId(loggedStudent);
    if (!currentChatId) {
      setTelegramChatIdInput('');
      setShowTelegramSettingsModal(true);
      return;
    }

    const nextState = true;
    await persistTelegramPreference(nextState);
    setToast({ message: 'تم تفعيل تنبيهات التليجرام بنجاح', type: 'success' });
  };

  const handleTelegramChatIdConfirm = async () => {
    const cleanedChatId = telegramChatIdInput.trim();
    if (!cleanedChatId) {
      setToast({ message: 'يرجى إدخال معرف التلجرام (Chat ID)', type: 'error' });
      return;
    }

    const studentId = String(loggedStudent?.['الرقم الجامعي'] ?? '').trim();
    if (!studentId) return;

    const nextChatId = cleanedChatId.replace(/[^0-9-]/g, '');
    if (!nextChatId) {
      setToast({ message: 'معرف التلجرام غير صالح', type: 'error' });
      return;
    }

    try {
      const { error } = await supabase.from('students').update({ telegram_chat_id: nextChatId, telegram_notifications_enabled: true }).eq('الرقم الجامعي', studentId);
      if (!error) {
        const updatedStudent = {
          ...(loggedStudent ?? {}),
          telegram_chat_id: nextChatId,
          telegram_notifications_enabled: true,
        } as StudentRow;

        setLoggedStudent(updatedStudent);
        setTelegramNotificationsEnabled(true);
        setShowTelegramSettingsModal(false);
        setTelegramChatIdInput('');
        window.localStorage.setItem(studentSessionStorageKey, JSON.stringify(updatedStudent));
        setToast({ message: 'تم تفعيل التنبيهات وحفظ معرف التلجرام', type: 'success' });
      } else {
        setToast({ message: 'تعذر حفظ معرف التلجرام', type: 'error' });
      }
    } catch {
      setToast({ message: 'حدث خطأ أثناء حفظ معرف التلجرام', type: 'error' });
    }
  };

  const refreshClassOptions = async () => {
    try {
      const results = await getClassAvailabilityOptions();
      const normalized = results.map((item) => ({
        ...item,
        name: String(item.name || '').trim() || 'غير محدد',
        available: item.available !== null ? Math.max(item.available, 0) : null,
      }));
      setClassOptions(normalized);

      if (loggedStudent?.['الفئة']) {
        const currentClass = String(loggedStudent['الفئة']).trim();
        const currentExists = normalized.some((item) => item.name === currentClass || `فئة ${item.name}` === currentClass || item.name === `فئة ${currentClass}`);
        if (!currentExists && normalized[0]) {
          setSelectedClassForUpdate(normalized[0].name);
        } else {
          setSelectedClassForUpdate(currentClass);
        }
      }
    } catch {
      setClassOptions([]);
    }
  };

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    try {
      const storedStudent = window.localStorage.getItem(studentSessionStorageKey);
      if (!storedStudent) return;
      const student = JSON.parse(storedStudent) as StudentRow;
      if (student?.['الرقم الجامعي']) {
        const restoredPreference = getStudentTelegramPreference(student);
        const restoredStudent = {
          ...(student as StudentRow),
          telegram_notifications_enabled: restoredPreference,
          telegram_chat_id: getStudentTelegramChatId(student) || undefined,
        } as StudentRow;

        setLoggedStudent(restoredStudent);
        setTelegramNotificationsEnabled(restoredPreference);
        setActiveTab('record');
        setIsLoggedIn(true);
        setNotice('تمت استعادة جلسة الطالب.');
      }
    } catch {
      window.localStorage.removeItem(studentSessionStorageKey);
    }
  }, []);

  const tabs = [
    { key: 'grades', label: 'العلامات' },
    { key: 'record', label: 'السجل' },
    { key: 'status', label: 'الحالة' },
  ] as const;

  useEffect(() => {
    if (loggedStudent) {
      void refreshClassOptions();
    }
  }, [loggedStudent]);

  const refreshDashboard = useCallback(async () => {
    if (!loggedStudent || !loggedStudent['الرقم الجامعي']) return;

    const studentId = String(loggedStudent['الرقم الجامعي']);

    try {
      const [attendanceResult, warningsResult, gradesResult, statusResult] = await Promise.all([
        getAttendanceForStudent(studentId).then((rows) => ({ data: rows })),
        getWarningsForStudent(studentId).then((rows) => ({ data: rows })),
        getTableRows(['الاعمال', 'الأعمال', 'أعمال', 'العملي', 'النظري']).then(({ data }) => ({
          data: Array.isArray(data) ? data.filter((row) => {
            const rowRecord = row as unknown as Record<string, unknown>;
            const rowStudentId = getValueByKeys(rowRecord, ['الرقم الجامعي', 'student_id', 'studentId']);
            return String(rowStudentId ?? '') === String(studentId);
          }) : [],
        })),
        Promise.resolve({ data: Array.isArray(loggedStudent) ? loggedStudent : [loggedStudent].filter(Boolean) }),
      ]);

      const gradeRows = gradesResult.data.flatMap((row) => extractGrades([row as unknown as Record<string, unknown>]));
      setGrades(gradeRows);
      setWarnings(warningsResult.data as unknown as Record<string, unknown>[]);
      setAttendanceSummary(parseAttendance(attendanceResult.data as unknown as Record<string, unknown>[]));

      const statusData = (statusResult.data[0] as Record<string, unknown> | undefined) ?? (loggedStudent as Record<string, unknown> | null) ?? {};
      const statusValue = getValueByKeys(statusData, ['الحالة', 'status', 'الحالة_الدراسية']) ?? 'غير متوفر';
      setStudentStatus(normalizeText(statusValue));
    } catch {
      setNotice('حدث خطأ أثناء تحديث البيانات من قاعدة البيانات');
    }
  }, [loggedStudent]);

  useEffect(() => {
    if (!loggedStudent || !loggedStudent['الرقم الجامعي']) return;

    void refreshDashboard();

    const intervalId = window.setInterval(() => {
      void refreshDashboard();
    }, 15000);

    const handleFocus = () => {
      void refreshDashboard();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshDashboard();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loggedStudent, refreshDashboard]);

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();

    const studentId = loginData.studentId.trim();
    const password = loginData.password.trim();

    if (!studentId || !password) {
      setNotice('يرجى إدخال الرقم الجامعي وكلمة السر');
      setToast({ message: 'يرجى إدخال الرقم الجامعي وكلمة السر', type: 'error' });
      return;
    }

    setIsLoading(true);
    setNotice('جاري التحقق من بيانات الدخول...');

    try {
      const user = await getStudentById(studentId);

      if (!user) {
        setNotice('الرقم الجامعي غير موجود في قاعدة البيانات');
        setToast({ message: 'الرقم الجامعي غير موجود', type: 'error' });
        return;
      }

      const storedPassword = String(getRecordValue(user as Record<string, unknown>, ['كلمة السر', 'password']) ?? '').trim();
      if (storedPassword !== password) {
        setNotice('كلمة السر غير صحيحة');
        setToast({ message: 'كلمة السر غير صحيحة', type: 'error' });
        return;
      }

      const preference = getStudentTelegramPreference(user as StudentRow);

      const hydratedUser = {
        ...(user as StudentRow),
        telegram_notifications_enabled: preference
      } as StudentRow;

      setLoggedStudent(hydratedUser);
      setTelegramNotificationsEnabled(preference);
      setActiveTab('record');
      setIsLoggedIn(true);
      window.localStorage.setItem(studentSessionStorageKey, JSON.stringify(hydratedUser));
      writeAuditLog({
        action: 'student_login',
        userType: 'student',
        userId: studentId,
        username: String(getRecordValue(user as Record<string, unknown>, ['اسم الطالب', 'student_name', 'name']) ?? ''),
      });
      const studentName = normalizeText(getRecordValue(user as Record<string, unknown>, ['اسم الطالب', 'student_name', 'name']));
      setNotice(`تم تسجيل الدخول بنجاح، مرحباً ${studentName}`);
      setToast({ message: `مرحباً ${studentName}`, type: 'success' });
    } catch (error) {
      setNotice('حدث خطأ أثناء تسجيل الدخول');
      setToast({ message: 'حدث خطأ أثناء تسجيل الدخول', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleClassChange = async () => {
    const nextClass = String(selectedClassForUpdate ?? '').trim();
    const currentClass = String(loggedStudent?.['الفئة'] ?? '').trim();

    if (!nextClass) {
      setToast({ message: 'يرجى اختيار الفئة المراد الانتقال إليها', type: 'error' });
      return;
    }

    if (nextClass === currentClass || `فئة ${nextClass}` === currentClass || nextClass === `فئة ${currentClass}`) {
      setToast({ message: 'هذه الفئة هي الفئة الحالية', type: 'info' });
      return;
    }

    setIsChangingClass(true);
    try {
      const result = await updateStudentClass(String(loggedStudent?.['الرقم الجامعي'] ?? ''), nextClass);
      if (!result.success) {
        setNotice(result.error === 'class-full' ? 'لا يمكن الانتقال إلى هذه الفئة لأن المقاعد ممتلئة' : 'تعذر تغيير الفئة');
        setToast({ message: result.error === 'class-full' ? 'لا توجد مقاعد متاحة في هذه الفئة' : 'تعذر تغيير الفئة', type: 'error' });
        return;
      }

      const updatedStudent = {
        ...(loggedStudent ?? {}),
        'الفئة': nextClass,
        'تاريخ_تغيير_الفئة': new Date().toISOString(),
      };

      setLoggedStudent(updatedStudent as StudentRow);
      window.localStorage.setItem(studentSessionStorageKey, JSON.stringify(updatedStudent));
      setNotice(`تم تغيير الفئة بنجاح إلى ${nextClass}`);
      setToast({ message: `تم تغيير الفئة إلى ${nextClass}`, type: 'success' });

      const telegramChatId = getStudentTelegramChatId(loggedStudent);
      if (telegramNotificationsEnabled && telegramChatId) {
        const telegramMessage = buildStudentTelegramMessage({
          studentName: String(loggedStudent?.['اسم الطالب'] ?? 'الطالب'),
          studentId: String(loggedStudent?.['الرقم الجامعي'] ?? ''),
          studentYear: String(loggedStudent?.['السنه الدراسية'] ?? 'غير محدد'),
          studentClass: nextClass,
          statusText: `تم تغيير الفئة بنجاح من ${currentClass || 'غير محددة'} إلى ${nextClass}.`,
        });
        const telegramResult = await sendTelegramNotification(telegramMessage, {
          chatId: telegramChatId,
          enabled: true,
        });

        if (telegramResult?.ok === true) {
          setNotice(`تم تغيير الفئة إلى ${nextClass} وإرسال إشعار إلى التلجرام.`);
        } else {
          setNotice(`تم تغيير الفئة إلى ${nextClass}، لكن تعذر إرسال إشعار التلجرام.`);
        }
      }

      await refreshClassOptions();
      writeAuditLog({
        action: 'student_class_changed',
        userType: 'student',
        userId: loggedStudent?.['الرقم الجامعي'],
        username: String(loggedStudent?.['اسم الطالب'] ?? ''),
        details: { previousClass: currentClass, nextClass },
      });
    } catch {
      setNotice('حدث خطأ أثناء تغيير الفئة');
      setToast({ message: 'حدث خطأ أثناء تغيير الفئة', type: 'error' });
    } finally {
      setIsChangingClass(false);
    }
  };

  const logout = () => {
    writeAuditLog({
      action: 'student_logout',
      userType: 'student',
      userId: loggedStudent?.['الرقم الجامعي'],
      username: String(loggedStudent?.['اسم الطالب'] ?? ''),
    });
    window.localStorage.removeItem(studentSessionStorageKey);
    setIsLoggedIn(false);
    setLoggedStudent(null);
    setLoginData({ studentId: '', password: '' });
    setNotice('تم تسجيل الخروج بنجاح');
  };

  if (!isLoggedIn) {
    return (
      <main
        className="login-shell"
        dir="rtl"
        style={{
          backgroundImage: "linear-gradient(rgba(10, 19, 17, 0.42), rgba(10, 19, 17, 0.42)), url('/building.jpg')",
          backgroundSize: 'cover',
          backgroundPosition: 'center center',
          backgroundRepeat: 'no-repeat',
          position: 'relative',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(255, 255, 255, 0.06)',
            backdropFilter: 'blur(0.5px)',
            zIndex: 0,
          }}
        />

        {toast && (
          <div className={`toast toast-${toast.type}`} role="status" aria-live="polite" style={{ zIndex: 5 }}>
            <span className="toast-icon">{toast.type === 'success' ? '✓' : toast.type === 'error' ? '✕' : 'ℹ'}</span>
            <span>{toast.message}</span>
          </div>
        )}

        <div className="login-card" style={{ position: 'relative', zIndex: 1 }}>
          <div className="institute-header login-institute-header">
            <img
              className="login-logo"
              src="https://drive.google.com/thumbnail?id=1WBYFxtmLUfuREUY1H5Uso5ltomjshWlq&sz=w1000"
              alt="شعار المعهد"
            />
            <h2>المعهد التقاني لطب الأسنان</h2>
            <h3>جامعة اللاذقية</h3>
          </div>

          <h1 className="login-title">استعلام قسم تعويضات أسنان</h1>

          <form onSubmit={handleLogin} className="login-form">
            <div className="form-group">
              <input
                type="text"
                value={loginData.studentId}
                onChange={(event) => setLoginData({ ...loginData, studentId: event.target.value })}
                placeholder="الرقم الجامعي"
                inputMode="numeric"
                required
                disabled={isLoading}
              />
            </div>

            <div className="form-group password-container">
              <input
                type={showPassword ? 'text' : 'password'}
                value={loginData.password}
                onChange={(event) => setLoginData({ ...loginData, password: event.target.value })}
                onKeyDown={(event) => setCapsLockOn(event.getModifierState ? event.getModifierState('CapsLock') : false)}
                onKeyUp={(event) => setCapsLockOn(event.getModifierState ? event.getModifierState('CapsLock') : false)}
                placeholder="كلمة السر"
                required
                disabled={isLoading}
              />
              <button
                type="button"
                className="toggle-password"
                aria-label={showPassword ? 'إخفاء كلمة السر' : 'إظهار كلمة السر'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((current) => !current)}
              >
                {showPassword ? 'إخفاء' : 'إظهار'}
              </button>
            </div>

            {capsLockOn && <div className="caps-warning">⚠️ Caps Lock مفعّل</div>}

            <button type="submit" className={`login-button ${isLoading ? 'is-loading' : ''}`} disabled={isLoading}>
              {isLoading ? (
                <>
                  <span className="spinner-inline" />
                  <span>جاري التحقق...</span>
                </>
              ) : (
                'عرض'
              )}
            </button>
          </form>

          <div className="login-help">
            <strong>ملاحظات:</strong>
            <span>استخدم الرقم الجامعي وكلمة السر الخاصة بك</span>
          </div>

          <div className="system-notice">{notice}</div>
        </div>

        <div className="login-footer">
          <Link href="/attendance/" className="admin-link">
            لوحة التحكم للمشرفين
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="student-shell" dir="rtl">
      <div className="student-page">
        <div className="container student-dashboard-container" id="mainContainer">
          <div className="student-brand-center student-identity-hero">
            <img
              className="institute-logo"
              src="https://drive.google.com/thumbnail?id=1WBYFxtmLUfuREUY1H5Uso5ltomjshWlq&sz=w1000"
              alt="شعار المعهد"
            />
            <div className="student-brand-text">
              <h2>المعهد التقاني لطب الأسنان</h2>
              <h3>جامعة اللاذقية</h3>
            </div>
          </div>

          <div className="barcode-section student-qr-section">
            <div className="barcode-box qr-box student-qr-card">
              <img
                className="barcode-svg qr-image"
                src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
                  `UDTI|${formatStudentValue(loggedStudent?.['اسم الطالب'])}|${formatStudentValue(loggedStudent?.['الرقم الجامعي'])}`
                )}`}
                alt="QR code للطالب"
              />
              <div className="barcode-name">{formatStudentValue(loggedStudent?.['اسم الطالب'])}</div>
              <div className="barcode-id">{formatStudentValue(loggedStudent?.['الرقم الجامعي'])}</div>
            </div>
          </div>

          <div className="system-notice">{notice}</div>

          <div className="header student-dashboard-title">
            <h1>الحساب الجامعي</h1>
          </div>

          <div className="student-info student-profile-grid">
            <div className="info-item"><span className="info-label"><i className="fa-solid fa-user" /> الاسم</span> {formatStudentValue(loggedStudent?.['اسم الطالب'])}</div>
            <div className="info-item"><span className="info-label"><i className="fa-solid fa-id-card" /> الرقم الجامعي</span> {formatStudentValue(loggedStudent?.['الرقم الجامعي'])}</div>
            <div className="info-item"><span className="info-label"><i className="fa-solid fa-building-columns" /> القسم</span> {formatStudentValue(loggedStudent?.['القسم'])}</div>
            <div className="info-item"><span className="info-label"><i className="fa-solid fa-graduation-cap" /> اسم الأب</span> {formatStudentValue(loggedStudent?.['اسم الاب'])}</div>
            <div className="info-item"><span className="info-label"><i className="fa-solid fa-users" /> الكنية</span> {formatStudentValue(loggedStudent?.['الكنية'])}</div>
            <div className="info-item"><span className="info-label"><i className="fa-solid fa-layer-group" /> الفئة</span> {formatStudentValue(loggedStudent?.['الفئة'])}</div>
            <div className="info-item"><span className="info-label"><i className="fa-solid fa-check-circle" /> السنة الدراسية</span> {formatStudentValue(loggedStudent?.['السنه الدراسية'])}</div>
          </div>

          <div className="student-quick-stats" aria-label="ملخص الحضور">
            {attendanceSummary.map((item) => (
              <div className={`student-quick-stat ${item.tone}`} key={item.tone}>
                <span className="student-quick-stat-value">{item.value}</span>
                <span className="student-quick-stat-label">{item.label}</span>
              </div>
            ))}
          </div>

          <div className="student-class-manager" style={{ marginTop: 24, padding: '20px 24px', background: '#f8fafc', borderRadius: 16, border: '1px solid #e2e8f0' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 18, color: '#0f172a' }}>تغيير الفئة</h3>
              <div style={{ color: '#475569', fontSize: 14 }}>
                {classOptions.length > 0
                  ? classOptions.filter((item) => item.available !== null && item.available > 0).length
                  : 0} فئة متاحة حالياً
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                value={selectedClassForUpdate}
                onChange={(event) => setSelectedClassForUpdate(event.target.value)}
                style={{ minWidth: 180, padding: '10px 12px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff' }}
              >
                <option value="">اختر الفئة</option>
                {classOptions.length > 0 ? classOptions.map((item) => {
                  const isDisabled = item.available !== null && item.available <= 0;
                  return (
                    <option key={item.name} value={item.name} disabled={isDisabled}>
                      {item.name} {item.available !== null ? `(${item.available} مقعد متاح)` : ''}{isDisabled ? ' - ممتلئة' : ''}
                    </option>
                  );
                }) : (
                  <option value={String(loggedStudent?.['الفئة'] ?? '')}>{formatStudentValue(loggedStudent?.['الفئة'])}</option>
                )}
              </select>

              <button
                type="button"
                onClick={() => void handleClassChange()}
                disabled={isChangingClass || !selectedClassForUpdate || !!classOptions.find((item) => item.name === selectedClassForUpdate)?.available && classOptions.find((item) => item.name === selectedClassForUpdate)?.available === 0}
                style={{
                  padding: '10px 18px',
                  borderRadius: 10,
                  border: 'none',
                  background: isChangingClass || !selectedClassForUpdate || !!classOptions.find((item) => item.name === selectedClassForUpdate)?.available && classOptions.find((item) => item.name === selectedClassForUpdate)?.available === 0 ? '#cbd5e1' : '#0f766e',
                  color: '#fff',
                  fontWeight: 700,
                  cursor: isChangingClass || !selectedClassForUpdate || !!classOptions.find((item) => item.name === selectedClassForUpdate)?.available && classOptions.find((item) => item.name === selectedClassForUpdate)?.available === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                {isChangingClass ? 'جاري التحديث...' : 'تغيير الفئة'}
              </button>
            </div>

            <div style={{ marginTop: 12, color: '#475569', fontSize: 14 }}>
              {classOptions.length > 0 && classOptions.find((item) => item.name === selectedClassForUpdate)?.available !== undefined
                ? `المقاعد المتبقية: ${classOptions.find((item) => item.name === selectedClassForUpdate)?.available ?? 'غير محدد'}`
                : 'لا توجد معلومات سعة مفعلة لهذا الفصل'}
            </div>
          </div>

          <div className="student-details-grid student-extra-details">
            <div className="detail-item" style={{ gridColumn: '1 / -1' }}>
              <div className="detail-label">إعدادات التنبيهات</div>
              <div style={{ marginBottom: 12, color: '#475569', fontSize: 14, lineHeight: 1.8 }}>
                فعّل التنبيهات للسماح للمعهد بالتواصل معك عبر التلجرام وإرسال الإعلانات المهمة، مثل توسّع الفئة، بدء تسجيل الحضور، أو تسجيل إنذار على حسابك.
              </div>
              <div className="detail-value" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span>{telegramNotificationsEnabled ? 'التنبيهات مفعلة' : 'التنبيهات متوقفة'}</span>
                <button
                  type="button"
                  onClick={() => void handleTelegramToggle()}
                  style={{
                    position: 'relative',
                    width: 56,
                    height: 30,
                    borderRadius: 999,
                    border: 'none',
                    background: telegramNotificationsEnabled ? '#10b981' : '#cbd5e1',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    padding: 0,
                  }}
                  aria-label={telegramNotificationsEnabled ? 'إيقاف التنبيهات' : 'تفعيل التنبيهات'}
                >
                  <span
                    style={{
                      position: 'absolute',
                      top: 4,
                      left: telegramNotificationsEnabled ? 28 : 4,
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: '#fff',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                      transition: 'all 0.2s ease',
                    }}
                  />
                </button>
              </div>
            </div>

            {showTelegramSettingsModal && (
              <div style={{ gridColumn: '1 / -1', background: '#f8fafc', border: '1px solid #dbeafe', borderRadius: 14, padding: 20 }}>
                <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>تفعيل تنبيهات التلجرام 🔔</div>
                <ol style={{ color: '#475569', lineHeight: 1.8, marginBottom: 12, paddingRight: 20 }}>
                  <li>اضغط على زر "فتح بوت المعهد" أدناه.</li>
                  <li>اضغط على زر (Start / ابدأ) داخل التلجرام.</li>
                  <li>قم بنسخ رقم الـ Chat ID الذي سيرسله لك البوت وضعه في الخانة المخصصة أدناه.</li>
                </ol>
                <a
                  href="https://t.me/DTI_Portal_Bot"
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'inline-block', marginBottom: 12, padding: '10px 14px', background: '#2563eb', color: '#fff', borderRadius: 10, textDecoration: 'none', fontWeight: 700 }}
                >
                  فتح بوت المعهد
                </a>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={telegramChatIdInput}
                    onChange={(event) => setTelegramChatIdInput(event.target.value)}
                    placeholder="ادخل رقم الـ Chat ID"
                    style={{ flex: 1, minWidth: 180, padding: '10px 12px', borderRadius: 10, border: '1px solid #cbd5e1' }}
                  />
                  <button
                    type="button"
                    onClick={() => void handleTelegramChatIdConfirm()}
                    style={{ padding: '10px 16px', borderRadius: 10, border: 'none', background: '#0f766e', color: '#fff', fontWeight: 700 }}
                  >
                    تأكيد وحفظ
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowTelegramSettingsModal(false)}
                    style={{ padding: '10px 16px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff', color: '#0f172a', fontWeight: 700 }}
                  >
                    إغلاق
                  </button>
                </div>
              </div>
            )}
            <div className="detail-item">
              <div className="detail-label">رقم الهاتف</div>
              <div className="detail-value">{formatStudentValue(loggedStudent?.['رقم الهاتف'])}</div>
            </div>
            <div className="detail-item">
              <div className="detail-label">البريد الإلكتروني</div>
              <div className="detail-value">{formatStudentValue(loggedStudent?.['البريد الإلكتروني'])}</div>
            </div>
            <div className="detail-item">
              <div className="detail-label">نوع التسجيل</div>
              <div className="detail-value">{formatStudentValue(loggedStudent?.['نوع التسجيل'])}</div>
            </div>
            <div className="detail-item">
              <div className="detail-label">تاريخ الإنشاء</div>
              <div className="detail-value">{formatDate(loggedStudent?.['تاريخ الإنشاء'])}</div>
            </div>
            <div className="detail-item">
              <div className="detail-label">تاريخ تغيير الفئة</div>
              <div className="detail-value">{formatDate(loggedStudent?.['تاريخ_تغيير_الفئة'])}</div>
            </div>
            <div className="detail-item">
              <div className="detail-label">ملاحظة</div>
              <div className="detail-value">{formatStudentValue(loggedStudent?.['ملاحظة'])}</div>
            </div>
          </div>

          <div className="tabs-container">
            <div className="tabs">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  className={`tab ${activeTab === tab.key ? 'active' : ''}`}
                  type="button"
                  onClick={() => {
                    setActiveTab(tab.key);
                    writeAuditLog({
                      action: 'student_tab_opened',
                      userType: 'student',
                      userId: loggedStudent?.['الرقم الجامعي'],
                      username: String(loggedStudent?.['اسم الطالب'] ?? ''),
                      details: { tab: tab.key },
                    });
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {activeTab === 'grades' && (
              <div className="tab-content active">
                {grades.length === 0 ? (
                  <div className="no-data">
                    <i className="fa-solid fa-table-list" />
                    <div>لا توجد بيانات للعلامات حتى الآن.</div>
                  </div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>المادة</th>
                        <th>أعمال السنة</th>
                        <th>نظري</th>
                        <th>عملي</th>
                        <th>المجموع</th>
                        <th>مساعدة امتحانية</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grades.map((item) => (
                        <tr key={item.subject}>
                          <td>{item.subject}</td>
                          <td>{item.annual ?? '—'}</td>
                          <td>{item.theory ?? '—'}</td>
                          <td>{item.practical ?? '—'}</td>
                          <td>{item.total ?? '—'}</td>
                          <td>{item.assistance}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {activeTab === 'record' && (
              <div className="tab-content active">
                {warnings.length === 0 ? (
                  <div className="no-data">
                    <i className="fa-solid fa-clipboard-list" />
                    <div>لا يوجد سجل للطالب في الوقت الحالي.</div>
                  </div>
                ) : (
                  <div className="warning-list">
                    {warnings.map((warning, index) => (
                      <div key={`${warning['الرقم الجامعي'] ?? 'warning'}-${index}`} className="warning-item">
                        <div className="warning-header">
                          <strong>{normalizeText(getValueByKeys(warning, ['نوع الإنذار']))}</strong>
                          <span className="warning-type">{normalizeText(getValueByKeys(warning, ['السبب']))}</span>
                        </div>
                        <div className="warning-reason">{normalizeText(getValueByKeys(warning, ['التفاصيل']))}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'status' && (
              <div className="tab-content active">
                <div className="status-grid">
                  <div className="status-card">
                    <div className="status-icon"><i className="fa-solid fa-check-circle" /></div>
                    <div className="status-title">الحالة الدراسية</div>
                    <div className="status-data">{studentStatus}</div>
                  </div>
                  <div className="status-card">
                    <div className="status-icon"><i className="fa-solid fa-user-check" /></div>
                    <div className="status-title">الفئة</div>
                    <div className="status-data">{formatStudentValue(loggedStudent?.['الفئة'])}</div>
                  </div>
                  <div className="status-card">
                    <div className="status-icon"><i className="fa-solid fa-calendar-days" /></div>
                    <div className="status-title">السنة الدراسية</div>
                    <div className="status-data">{formatStudentValue(loggedStudent?.['السنه الدراسية'])}</div>
                  </div>
                </div>
              </div>
            )}

          </div>

          <div className="last-updated">آخر تحديث للنظام: {formatDate(loggedStudent?.['تاريخ_تغيير_الفئة'])}</div>

          <div className="student-footer-actions">
            <button className="logout-button" type="button" onClick={logout}>تسجيل الخروج</button>
          </div>
        </div>
      </div>
    </main>
  );
}
