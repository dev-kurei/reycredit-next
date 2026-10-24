-- ============================================================
-- REY CREDIT — Supabase schema
-- Paste this whole file into the Supabase SQL editor (one project,
-- run once) — Database -> SQL Editor -> New query -> paste -> Run.
-- ============================================================

-- IDs are plain integers (bigint identity), not UUIDs. The existing
-- front-end (kept unchanged in this migration) treats a loan's identifier
-- as a Number in several places -- a straight carryover from when it was a
-- spreadsheet row number. Integer ids let that code work untouched; nothing
-- about the API or the database cares which kind of id is used.
create table if not exists borrowers (
  id          bigint generated always as identity primary key,
  name        text not null,
  email       text not null unique,
  contact     text default '',
  address     text default '',
  valid_id    text default '',
  cc_email    text default '',
  created_at  timestamptz not null default now()
);

create table if not exists banks (
  id             bigint generated always as identity primary key,
  name           text not null unique,
  statement_day  int  not null default 1,
  due_day        int  not null default 1,
  due_month      text not null default 'Next Month' check (due_month in ('Next Month','Same Month'))
);

-- Loans reference their borrower by id, not by re-typed name/email -- this is
-- what permanently fixes two old bugs: renaming a loan orphaning its payment
-- history, and two loans sharing a name colliding on the same history. Both
-- are now structurally impossible: payments key off loan_id, and the unique
-- constraint below blocks a duplicate name for the same borrower outright.
create table if not exists loans (
  id              bigint generated always as identity primary key,
  borrower_id     bigint not null references borrowers(id) on delete cascade,
  loan_name       text not null,
  loan_type       text default '',
  start_date      date not null,
  principal       numeric(12,2) not null,
  terms           int not null,
  monthly_rate    numeric(8,4) not null default 0,   -- e.g. 1.00 means 1%
  processing_fee  numeric(12,2) not null default 0,
  total_interest  numeric(12,2) not null default 0,
  total_payable   numeric(12,2) not null,
  monthly_amort   numeric(12,2) not null,
  bank_id         bigint references banks(id),
  due_day         int default 1,
  closed          boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (borrower_id, loan_name)
);

create table if not exists payments (
  id          bigint generated always as identity primary key,
  loan_id     bigint not null references loans(id) on delete cascade,
  for_month   text not null,               -- "August 2026"
  amount      numeric(12,2) not null,
  paid_date   date not null,
  receipt_no  text default '',
  method      text default 'Cash',
  created_at  timestamptz not null default now()
);

create table if not exists users (
  id             bigint generated always as identity primary key,
  email          text not null unique,
  password_hash  text not null,
  role           text not null default 'BORROWER' check (role in ('ADMIN','BORROWER')),
  created_at     timestamptz not null default now()
);

create table if not exists config (
  key    text primary key,
  value  text
);

create index if not exists idx_loans_borrower on loans(borrower_id);
create index if not exists idx_payments_loan  on payments(loan_id);
create index if not exists idx_payments_date  on payments(paid_date);

-- Row Level Security: locked down by default. Every read and write goes
-- through the Next.js API routes using the SERVICE ROLE key, which bypasses
-- RLS -- the browser is never given a key that could query these tables
-- directly, so this is a hard backstop, not the primary access control.
alter table borrowers enable row level security;
alter table banks     enable row level security;
alter table loans     enable row level security;
alter table payments  enable row level security;
alter table users     enable row level security;
alter table config    enable row level security;

-- Seed the business config with the same defaults the old system used.
-- Edit these afterwards from Settings in the app -- no SQL needed later.
insert into config (key, value) values
  ('COMPANY_NAME',      'Rey Credit'),
  ('LENDER_NAME',       'Your Name'),
  ('SUPPORT_EMAIL',     'billing@example.com'),
  ('SUPPORT_PHONE',     '09XXXXXXXXX'),
  ('COMPANY_ADDR',      'Your city, Province'),
  ('LENDER_ADDR',       'Your street, city, Province'),
  ('LOGO_URL',          ''),
  ('LENDER_SIG_URL',    ''),
  ('PORTAL_URL',        ''),
  ('DOMAIN_URL',        ''),
  ('GCASH_ACCOUNT',     '09XXXXXXXXX'),
  ('BPI_ACCOUNT',       ''),
  ('MARIBANK_ACCOUNT',  ''),
  ('PENALTY_RATE',      '3'),
  ('OFFICE_HOURS',      'Mon - Sat, 8AM - 5PM')
on conflict (key) do nothing;

-- Seed the first admin login so you can get in at all.
-- Email: admin@reycredit.local   Password: changeme123
-- (bcrypt hash, 10 rounds -- generated and verified with bcryptjs before
--  being pasted here, so this genuinely works on first sign-in)
-- CHANGE THIS PASSWORD immediately after signing in.
insert into users (email, password_hash, role) values
  ('admin@reycredit.local', '$2a$10$dPRlt02j0Nz80WdLrG..5.BNjMONI3/fIkVNnQdSQtw6Ex2ekCIhu', 'ADMIN')
on conflict (email) do nothing;
