create index if not exists students_university_id_idx
  on public.students ("الرقم الجامعي");

create index if not exists students_phone_idx
  on public.students ("رقم الهاتف");

create index if not exists attendance_university_id_idx
  on public."الحضور" ("الرقم الجامعي");

create index if not exists warnings_university_id_idx
  on public."الإنذارات" ("الرقم الجامعي");

create index if not exists supervisor_username_idx
  on public."المشرفين" ("اسم المستخدم");

create index if not exists schedule_group_day_time_idx
  on public.schedule_items (group_name, day, start_time);