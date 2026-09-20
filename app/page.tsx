'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { writeAuditLog } from '../lib/auditLog';
import {
  getClassAvailabilityOptions,
  getStudentById,
  getWarningsForStudent,
  getRecordValue,
  normalizeText,
  StudentRow,
} from '../lib/studentData';

type TabKey = 'grades' | 'record' | 'status' | 'schedule';

type ScheduleItem = {
  id: string | number;
  day: string;
  start_time: string;
  end_time: string;
  subject: string;
  type: string;
  location: string;
  group_name: string | null;
};

type GradeEntry = {
  subject: string;
  annual: number | null;
  theory: number | null;
  practical: number | null;
  total: number | null;
  assistance: string;
};

const studentSessionStorageKey = 'udti-student-session';
const rememberedStudentIdStorageKey = 'udti-remembered-student-id';
const rememberedStudentPasswordStorageKey = 'udti-remembered-student-password';

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

const scheduleDays = ['الأحد', 'الأثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];

const formatScheduleTime = (value: unknown) => String(value ?? '').slice(0, 5);

const getStudentGroup = (student: Record<string, unknown> | null | undefined) => String(
  student?.['الفئة'] ?? student?.group ?? student?.group_name ?? ''
).trim().replace(/^فئة\s*/i, '');

export default function Home() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('record');
  const [notice, setNotice] = useState('يرجى تسجيل الدخول لعرض نتائجك');
  const [loginData, setLoginData] = useState({ studentId: '', password: '' });
  const [rememberStudentId, setRememberStudentId] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [loggedStudent, setLoggedStudent] = useState<StudentRow | null>(null);
  const [grades, setGrades] = useState<GradeEntry[]>([]);
  const [warnings, setWarnings] = useState<Record<string, unknown>[]>([]);
  const [scheduleItems, setScheduleItems] = useState<ScheduleItem[]>([]);
  const [studentStatus, setStudentStatus] = useState<string>('غير متوفر');
  const [classOptions, setClassOptions] = useState<Array<{ name: string; capacity: number | null; occupied: number; available: number | null }>>([]);
  const [selectedClassForUpdate, setSelectedClassForUpdate] = useState('');
  const [isChangingClass, setIsChangingClass] = useState(false);
  const [newStudentId, setNewStudentId] = useState('');
  const [studentIdChangeConfirmed, setStudentIdChangeConfirmed] = useState(false);
  const [isChangingStudentId, setIsChangingStudentId] = useState(false);
  const [studentIdChangeCompleted, setStudentIdChangeCompleted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [telegramNotificationsEnabled, setTelegramNotificationsEnabled] = useState(false);
  const [showTelegramSettingsModal, setShowTelegramSettingsModal] = useState(false);
  const [telegramChatIdInput, setTelegramChatIdInput] = useState('');
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const [resetIdentifier, setResetIdentifier] = useState('');
  const [resetMethods, setResetMethods] = useState<Array<'telegram' | 'email'>>([]);
  const [resetMethod, setResetMethod] = useState<'telegram' | 'email'>('email');
  const [resetDestination, setResetDestination] = useState('');
  const [resetCodeSent, setResetCodeSent] = useState(false);
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const hasStudentGroup = Boolean(getStudentGroup(loggedStudent as Record<string, unknown> | null));

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
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    const rememberedStudentId = window.localStorage.getItem(rememberedStudentIdStorageKey)?.trim();
    const rememberedStudentPassword = window.localStorage.getItem(rememberedStudentPasswordStorageKey) ?? '';
    if (rememberedStudentId || rememberedStudentPassword) {
      setLoginData((current) => ({
        studentId: rememberedStudentId ?? current.studentId,
        password: rememberedStudentPassword,
      }));
    }
    window.localStorage.removeItem(studentSessionStorageKey);
  }, []);

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'grades', label: 'العلامات' },
    { key: 'record', label: 'السجل' },
    { key: 'status', label: 'الحالة' },
    ...(hasStudentGroup ? [{ key: 'schedule' as const, label: 'برنامج الدوام' }] : []),
  ];

  useEffect(() => {
    if (loggedStudent) {
      void refreshClassOptions();

      const studentId = String(loggedStudent['الرقم الجامعي'] ?? '').trim();
      if (studentId) {
        void fetch(`/api/student/student-id-change?studentId=${encodeURIComponent(studentId)}`)
          .then((response) => response.json() as Promise<{ success?: boolean; used?: boolean }>)
          .then((result) => {
            if (result.success) setStudentIdChangeCompleted(result.used === true);
          })
          .catch(() => undefined);
      }
    }
  }, [loggedStudent]);

  useEffect(() => {
    if (!isLoggedIn) return;

    const studentHistoryState = { studentPortal: true };
    window.history.pushState(studentHistoryState, '', window.location.pathname || '/');
    const handleStudentBackNavigation = () => {
      window.history.pushState(studentHistoryState, '', '/');
      setNotice('أنت داخل بوابة الطالب. استخدم تسجيل الخروج للعودة إلى صفحة الدخول.');
    };

    window.addEventListener('popstate', handleStudentBackNavigation);
    return () => window.removeEventListener('popstate', handleStudentBackNavigation);
  }, [isLoggedIn]);

  const refreshDashboard = useCallback(async () => {
    if (!loggedStudent || !loggedStudent['الرقم الجامعي']) return;

    const studentId = String(loggedStudent['الرقم الجامعي']);

    try {
      const [studentResult, warningsResult, gradesResult, scheduleResult] = await Promise.all([
        getStudentById(studentId),
        getWarningsForStudent(studentId).then((rows) => ({ data: rows })),
        getTableRows(['الاعمال', 'الأعمال', 'أعمال', 'العملي', 'النظري']).then(({ data }) => ({
          data: Array.isArray(data) ? data.filter((row) => {
            const rowRecord = row as unknown as Record<string, unknown>;
            const rowStudentId = getValueByKeys(rowRecord, ['الرقم الجامعي', 'student_id', 'studentId']);
            return String(rowStudentId ?? '') === String(studentId);
          }) : [],
        })),
        hasStudentGroup
          ? supabase.from('schedule_items').select('id, day, start_time, end_time, subject, type, location, group_name')
          : Promise.resolve({ data: [], error: null }),
      ]);

      const freshStudent = studentResult ?? loggedStudent;
      if (freshStudent && JSON.stringify(freshStudent) !== JSON.stringify(loggedStudent)) {
        setLoggedStudent(freshStudent);
      }

      const gradeRows = gradesResult.data.flatMap((row) => extractGrades([row as unknown as Record<string, unknown>]));
      setGrades(gradeRows);
      setWarnings(warningsResult.data as unknown as Record<string, unknown>[]);
      const currentGroup = getStudentGroup(freshStudent as Record<string, unknown>);
      if (!scheduleResult.error) {
        const matchingSchedule = (Array.isArray(scheduleResult.data) ? scheduleResult.data : [])
          .filter((item) => {
            const scheduleItem = item as Record<string, unknown>;
            const itemGroup = String(scheduleItem.group_name ?? '').trim();
            return !itemGroup || itemGroup === currentGroup;
          })
          .map((item) => item as ScheduleItem)
          .sort((first, second) => `${scheduleDays.indexOf(first.day)}-${first.start_time}`.localeCompare(`${scheduleDays.indexOf(second.day)}-${second.start_time}`));
        setScheduleItems(matchingSchedule);
      } else {
        setScheduleItems([]);
      }
      if (!currentGroup && activeTab === 'schedule') setActiveTab('record');
      const statusData = (freshStudent as Record<string, unknown> | null) ?? {};
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
      if (rememberStudentId) {
        window.localStorage.setItem(rememberedStudentIdStorageKey, studentId);
        window.localStorage.setItem(rememberedStudentPasswordStorageKey, password);
      } else {
        window.localStorage.removeItem(rememberedStudentIdStorageKey);
        window.localStorage.removeItem(rememberedStudentPasswordStorageKey);
      }
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

  const resetErrorMessage = (error?: string) => ({
    'student-not-found': 'لم يتم العثور على طالب بهذا الرقم أو رقم الهاتف.',
    'student-email-missing': 'لا يوجد بريد إلكتروني مسجل لهذا الحساب.',
    'no-recovery-method': 'لا يوجد تلجرام مربوط أو بريد إلكتروني مسجل لهذا الطالب.',
    'student-query-failed': 'تعذر الوصول إلى بيانات الطلاب، حاول مرة أخرى.',
    'password-reset-table-missing': 'ميزة استعادة كلمة المرور غير مفعلة بعد في قاعدة البيانات.',
    'reset-code-save-failed': 'تعذر حفظ رمز التحقق، حاول مرة أخرى.',
    'code-send-failed': 'تعذر إرسال رمز التحقق، حاول مرة أخرى.',
    'telegram-send-failed': 'تعذر إرسال رمز التحقق عبر التليجرام، تحقق من إعدادات البوت.',
    'email-send-failed': 'تعذر إرسال رمز التحقق عبر البريد الإلكتروني.',
    'invalid-code': 'رمز التحقق غير صحيح.',
    'code-expired': 'انتهت صلاحية الرمز، اطلب رمزًا جديدًا.',
    'too-many-attempts': 'تم تجاوز عدد المحاولات، اطلب رمزًا جديدًا.',
    'invalid-reset-input': 'أدخل رمزًا من 6 أرقام وكلمة مرور من 8 محارف على الأقل.',
  }[error ?? ''] ?? 'حدث خطأ أثناء استعادة كلمة المرور.');

  const requestPasswordResetCode = async () => {
    const identifier = resetIdentifier.trim();
    if (!identifier) {
      setToast({ message: 'أدخل الرقم الجامعي أو رقم الهاتف أولًا.', type: 'error' });
      return;
    }

    setResetLoading(true);
    try {
      const response = await fetch('/api/student/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, method: resetMethods.length ? resetMethod : undefined }),
      });
      const result = await response.json() as { success?: boolean; error?: string; methods?: Array<'telegram' | 'email'>; method?: 'telegram' | 'email'; destination?: string; requiresMethod?: boolean };
      if (!result.success) {
        setToast({ message: resetErrorMessage(result.error), type: 'error' });
        return;
      }

      setResetMethods(result.methods ?? []);
      setResetMethod(result.method ?? result.methods?.[0] ?? 'email');
      if (result.requiresMethod) {
        setToast({ message: 'اختر طريقة إرسال رمز التحقق.', type: 'info' });
        return;
      }
      setResetDestination(result.destination ?? 'وسيلة التواصل المرتبطة');
      setResetCodeSent(true);
      setToast({ message: `تم إرسال رمز التحقق عبر ${result.method === 'telegram' ? 'التليجرام' : 'البريد الإلكتروني'}.`, type: 'success' });
    } catch {
      setToast({ message: 'تعذر الاتصال بخدمة استعادة كلمة المرور.', type: 'error' });
    } finally {
      setResetLoading(false);
    }
  };

  const sendSelectedPasswordResetCode = async () => {
    await requestPasswordResetCode();
  };

  const verifyPasswordReset = async () => {
    setResetLoading(true);
    try {
      const response = await fetch('/api/student/password-reset/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: resetIdentifier, code: resetCode, newPassword }),
      });
      const result = await response.json() as { success?: boolean; error?: string };
      if (!result.success) {
        setToast({ message: resetErrorMessage(result.error), type: 'error' });
        return;
      }

      setShowPasswordReset(false);
      setResetCodeSent(false);
      setResetIdentifier('');
      setResetCode('');
      setNewPassword('');
      setToast({ message: 'تم تغيير كلمة المرور بنجاح، يمكنك تسجيل الدخول الآن.', type: 'success' });
    } catch {
      setToast({ message: 'تعذر التحقق من رمز الاستعادة.', type: 'error' });
    } finally {
      setResetLoading(false);
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
      const response = await fetch('/api/student/class-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId: String(loggedStudent?.['الرقم الجامعي'] ?? ''),
          nextClass,
        }),
      });
      const result = await response.json() as { success?: boolean; error?: string; emailSent?: boolean; telegramSent?: boolean };
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
      const notificationText = [
        result.emailSent ? 'البريد الإلكتروني' : '',
        result.telegramSent ? 'التليجرام' : '',
      ].filter(Boolean).join(' و ');
      setNotice(notificationText
        ? `تم تغيير الفئة إلى ${nextClass} وإرسال إشعار عبر ${notificationText}.`
        : `تم تغيير الفئة إلى ${nextClass}.`);
      setToast({ message: `تم تغيير الفئة إلى ${nextClass}`, type: 'success' });

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

  const handleStudentIdChange = async () => {
    const currentStudentId = String(loggedStudent?.['الرقم الجامعي'] ?? '').trim();
    const nextStudentId = newStudentId.trim();

    if (!currentStudentId || !/^\d+$/.test(nextStudentId)) {
      setToast({ message: 'أدخل رقمًا جامعيًا جديدًا صحيحًا.', type: 'error' });
      return;
    }
    if (!studentIdChangeConfirmed) {
      setToast({ message: 'يجب تأكيد مطابقة الرقم للقوائم المنشورة وتحمل مسؤولية إدخاله.', type: 'error' });
      return;
    }

    setIsChangingStudentId(true);
    try {
      const response = await fetch('/api/student/student-id-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentStudentId, newStudentId: nextStudentId, confirmed: true }),
      });
      const result = await response.json() as { success?: boolean; studentId?: string; details?: string; error?: string };
      if (!response.ok || !result.success) {
        setToast({ message: result.details ?? 'تعذر تغيير الرقم الجامعي.', type: 'error' });
        return;
      }

      const updatedStudent = { ...(loggedStudent ?? {}), 'الرقم الجامعي': result.studentId ?? nextStudentId } as StudentRow;
      setLoggedStudent(updatedStudent);
      if (rememberStudentId) {
        window.localStorage.setItem(rememberedStudentIdStorageKey, result.studentId ?? nextStudentId);
      }
      setNewStudentId('');
      setStudentIdChangeConfirmed(false);
      setStudentIdChangeCompleted(true);
      setNotice('تم تغيير الرقم الجامعي بنجاح. هذا التغيير متاح مرة واحدة فقط.');
      setToast({ message: 'تم تغيير الرقم الجامعي بنجاح.', type: 'success' });
      writeAuditLog({
        action: 'student_id_changed',
        userType: 'student',
        userId: result.studentId ?? nextStudentId,
        username: String(loggedStudent?.['اسم الطالب'] ?? ''),
        details: { previousStudentId: currentStudentId, nextStudentId: result.studentId ?? nextStudentId },
      });
    } catch {
      setToast({ message: 'تعذر الاتصال بخدمة تغيير الرقم الجامعي.', type: 'error' });
    } finally {
      setIsChangingStudentId(false);
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
    setNewStudentId('');
    setStudentIdChangeConfirmed(false);
    setStudentIdChangeCompleted(false);
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

        <div className={`login-card ${showPasswordReset ? 'password-reset-mode' : ''}`} style={{ position: 'relative', zIndex: 1 }}>
          <div className="institute-header login-institute-header">
            <img
              className="login-logo"
              src="/institute-logo.png"
              alt="شعار المعهد"
            />
            <h2>المعهد التقاني لطب الأسنان</h2>
            <h3>جامعة اللاذقية</h3>
          </div>

          <h1 className="login-title">{showPasswordReset ? 'إعادة تعيين كلمة المرور' : 'استعلام قسم تعويضات أسنان'}</h1>

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

            <label style={{ display: 'flex', alignItems: 'center', gap: 5, margin: '0 0 7px', color: '#64748b', fontSize: 11 }}>
              <input
                type="checkbox"
                checked={rememberStudentId}
                onChange={(event) => setRememberStudentId(event.target.checked)}
                disabled={isLoading}
                style={{ width: 13, height: 13, margin: 0 }}
              />
              تذكر الرقم الجامعي وكلمة المرور
            </label>

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

          <button
            type="button"
            className="forgot-password-button"
            aria-expanded={showPasswordReset}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const nextState = !showPasswordReset;
              setShowPasswordReset(nextState);
              setResetCodeSent(false);
              setResetMethods([]);
              if (!nextState) {
                setResetIdentifier('');
                setResetCode('');
                setNewPassword('');
              }
            }}
          >
            {showPasswordReset ? 'العودة إلى تسجيل الدخول' : 'نسيت كلمة المرور؟'}
          </button>

          {showPasswordReset && (
            <section className="password-reset-panel">
              <h3>استعادة كلمة المرور</h3>
              <p>أدخل الرقم الجامعي أو رقم الهاتف للبحث عن حسابك.</p>
              <input
                type="text"
                value={resetIdentifier}
                onChange={(event) => setResetIdentifier(event.target.value)}
                placeholder="الرقم الجامعي أو رقم الهاتف"
                disabled={resetLoading || resetCodeSent}
              />
              <div className="password-reset-phone-hint">
                إذا كنت تستخدم رقم الهاتف، اكتبه بدون الصفر الأول، مثال: 992222222
              </div>

              {!resetCodeSent && resetMethods.length > 1 && (
                <div className="password-reset-methods">
                  <span>اختر طريقة إرسال رمز التحقق:</span>
                  <div>
                    {resetMethods.includes('telegram') && <button type="button" className={resetMethod === 'telegram' ? 'selected' : ''} onClick={() => setResetMethod('telegram')}>التليجرام</button>}
                    {resetMethods.includes('email') && <button type="button" className={resetMethod === 'email' ? 'selected' : ''} onClick={() => setResetMethod('email')}>البريد الإلكتروني</button>}
                  </div>
                </div>
              )}

              {!resetCodeSent ? (
                <button type="button" className="login-button password-reset-action" onClick={sendSelectedPasswordResetCode} disabled={resetLoading}>
                  {resetLoading ? 'جاري الإرسال...' : resetMethods.length > 1 ? 'إرسال رمز التحقق' : 'متابعة'}
                </button>
              ) : (
                <>
                  <div className="password-reset-destination">تم إرسال الرمز عبر {resetMethod === 'telegram' ? 'التليجرام' : `البريد الإلكتروني (${resetDestination})`}</div>
                  <input type="text" inputMode="numeric" maxLength={6} value={resetCode} onChange={(event) => setResetCode(event.target.value.replace(/\D/g, ''))} placeholder="رمز التحقق - 6 أرقام" disabled={resetLoading} />
                  <input type="password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="كلمة المرور الجديدة - 8 محارف على الأقل" disabled={resetLoading} />
                  <button type="button" className="login-button password-reset-action" onClick={() => void verifyPasswordReset()} disabled={resetLoading}>
                    {resetLoading ? 'جاري التحقق...' : 'تغيير كلمة المرور'}
                  </button>
                  <button type="button" className="password-reset-resend" onClick={() => { setResetCodeSent(false); setResetCode(''); setNewPassword(''); }}>
                    إرسال رمز جديد
                  </button>
                </>
              )}
            </section>
          )}

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
              src="/institute-logo.png"
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

          <div className="student-class-manager" style={{ marginTop: 24, padding: '20px 24px', background: '#f8fafc', borderRadius: 16, border: '1px solid #e2e8f0' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 16 }}>
              <h3 className="class-change-title" style={{ margin: 0, fontSize: 18, color: '#0f172a' }}>تغيير الفئة</h3>
              <div className="class-change-muted" style={{ color: '#475569', fontSize: 14 }}>
                {classOptions.length > 0
                  ? classOptions.filter((item) => item.available !== null && item.available > 0).length
                  : 0} فئة متاحة حالياً
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                value={selectedClassForUpdate}
                onChange={(event) => setSelectedClassForUpdate(event.target.value)}
                className="class-change-select"
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

            <div className="class-change-muted" style={{ marginTop: 12, color: '#475569', fontSize: 14 }}>
              {classOptions.length > 0 && classOptions.find((item) => item.name === selectedClassForUpdate)?.available !== undefined
                ? `المقاعد المتبقية: ${classOptions.find((item) => item.name === selectedClassForUpdate)?.available ?? 'غير محدد'}`
                : 'لا توجد معلومات سعة مفعلة لهذا الفصل'}
            </div>
          </div>

          {!studentIdChangeCompleted && (
            <div className="student-id-change-manager" style={{ marginTop: 18, padding: '20px 24px', background: '#fffaf0', borderRadius: 16, border: '1px solid #ead7ad' }}>
            <h3 style={{ margin: 0, fontSize: 18, color: '#7c4a03' }}>تغيير الرقم الجامعي</h3>
            <p style={{ margin: '10px 0 6px', color: '#5f4b2b', fontSize: 14, lineHeight: 1.8 }}>
              يمكنك تغيير الرقم الجامعي مرة واحدة فقط. أدخل الرقم الوزاري المطابق للقوائم المنشورة الرسمية.
            </p>
            <p style={{ margin: '0 0 14px', color: '#8a3d12', fontSize: 14, fontWeight: 700, lineHeight: 1.8 }}>
              تنبيه: أي خطأ في تعيين الرقم الجامعي يتحمل الطالب مسؤوليته الكاملة.
            </p>
            <input
              value={newStudentId}
              onChange={(event) => setNewStudentId(event.target.value.replace(/\D/g, ''))}
              placeholder="الرقم الجامعي الجديد حسب القوائم الوزارية"
              inputMode="numeric"
              disabled={studentIdChangeCompleted || isChangingStudentId}
              style={{ width: '100%', minHeight: 44, padding: '10px 12px', border: '1px solid #d6bd87', borderRadius: 9, background: '#fff', color: '#3f2b12', fontFamily: 'inherit' }}
            />
            <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 12, color: '#5f4b2b', fontSize: 13, lineHeight: 1.7 }}>
              <input
                type="checkbox"
                checked={studentIdChangeConfirmed}
                onChange={(event) => setStudentIdChangeConfirmed(event.target.checked)}
                disabled={studentIdChangeCompleted || isChangingStudentId}
                style={{ marginTop: 4 }}
              />
              أؤكد أن الرقم مطابق للقوائم المنشورة والرقم الوزاري، وأتحمل مسؤولية أي خطأ في إدخاله.
            </label>
            <button
              type="button"
              onClick={() => void handleStudentIdChange()}
              disabled={studentIdChangeCompleted || isChangingStudentId || !newStudentId.trim() || !studentIdChangeConfirmed}
              style={{ marginTop: 14, padding: '10px 18px', border: 'none', borderRadius: 9, background: studentIdChangeCompleted || isChangingStudentId || !newStudentId.trim() || !studentIdChangeConfirmed ? '#c9b98f' : '#9a5b0a', color: '#fff', fontWeight: 700, cursor: studentIdChangeCompleted || isChangingStudentId || !newStudentId.trim() || !studentIdChangeConfirmed ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}
            >
              {studentIdChangeCompleted ? 'تم استخدام التغيير' : isChangingStudentId ? 'جاري الحفظ...' : 'تأكيد تغيير الرقم'}
            </button>
            </div>
          )}

          <div className="student-details-grid student-extra-details">
            <div className="detail-item" style={{ gridColumn: '1 / -1' }}>
              <div className="detail-label">إعدادات التنبيهات</div>
              <div className="notification-description" style={{ marginBottom: 12, color: '#475569', fontSize: 14, lineHeight: 1.8 }}>
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
              <div className="student-telegram-modal" style={{ gridColumn: '1 / -1', background: '#f8fafc', border: '1px solid #dbeafe', borderRadius: 14, padding: 20 }}>
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

            {activeTab === 'schedule' && (
              <div className="tab-content active">
                <div style={{ display: 'grid', gap: 18 }}>
                  {scheduleDays.map((day) => {
                    const dayItems = scheduleItems
                      .filter((item) => item.day === day)
                      .sort((first, second) => first.start_time.localeCompare(second.start_time));

                    return (
                      <section key={day} style={{ display: 'grid', gap: 10 }}>
                        <h3 style={{ margin: 0, paddingBottom: 8, borderBottom: '2px solid #e2e8f0', color: '#0f172a', fontSize: 17 }}>
                          {day}
                        </h3>
                        {dayItems.length === 0 ? (
                          <div style={{ padding: '12px 14px', borderRadius: 10, background: '#f8fafc', color: '#64748b', fontSize: 14 }}>
                            لا توجد محاضرات مسجلة
                          </div>
                        ) : (
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 10 }}>
                            {dayItems.map((item) => {
                              const isPractical = item.type.trim() === 'عملي';
                              return (
                                <article
                                  key={item.id}
                                  style={{
                                    padding: 14,
                                    borderRadius: 12,
                                    border: `1px solid ${isPractical ? '#f4c77b' : '#a8c9ed'}`,
                                    background: isPractical ? '#fff8e8' : '#eff7ff',
                                  }}
                                >
                                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                                    <strong style={{ color: '#0f172a', lineHeight: 1.6 }}>{item.subject}</strong>
                                    <span style={{ color: isPractical ? '#9a5b0a' : '#2563a8', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>
                                      {isPractical ? 'عملي' : 'نظري'}
                                    </span>
                                  </div>
                                  <div style={{ marginTop: 10, color: '#334155', fontSize: 14 }}>
                                    {formatScheduleTime(item.start_time)} - {formatScheduleTime(item.end_time)}
                                  </div>
                                  <div style={{ marginTop: 5, color: '#64748b', fontSize: 13 }}>
                                    {item.location || 'القاعة غير محددة'}
                                    {item.group_name ? ` · المجموعة ${item.group_name}` : ''}
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
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
