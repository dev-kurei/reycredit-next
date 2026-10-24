-- Sign-in protection. Run once in the Supabase SQL Editor.
--  * 5 wrong passwords lock an account for 15 minutes
--  * "Forgot password" is limited to 3 requests an hour per account
-- Until this table exists the app still works, but without the lockout.
create table if not exists login_attempts (
  email              text primary key,
  failures           int not null default 0,
  last_failure       timestamptz,
  locked_until       timestamptz,
  resets             int not null default 0,
  reset_window_start timestamptz
);
alter table login_attempts enable row level security;
