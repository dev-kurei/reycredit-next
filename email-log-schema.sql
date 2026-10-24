-- ============================================================
-- REY CREDIT -- Email log table
-- Paste into the Supabase SQL editor and run once.
-- Keeps its own record of every email the app sends, independent of
-- Resend's own 30-day dashboard retention and reachable without leaving
-- the app.
-- ============================================================
create table if not exists email_log (
  id          bigint generated always as identity primary key,
  loan_id     bigint references loans(id) on delete set null,
  borrower_name text default '',
  to_email    text not null,
  cc_email    text default '',
  email_type  text not null,     -- welcome | new_loan | statement | reminder | receipt | reset_pin
  subject     text default '',
  status      text not null check (status in ('sent','failed')),
  error_message text default '',
  resend_id   text default '',
  created_at  timestamptz not null default now()
);

create index if not exists idx_email_log_created on email_log(created_at desc);
create index if not exists idx_email_log_loan on email_log(loan_id);

alter table email_log enable row level security;
