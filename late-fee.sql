-- ============================================================
-- REY CREDIT -- flat late payment fee, stored per loan
-- Paste into the Supabase SQL editor and run once.
--   late_fee       flat peso amount charged for every cycle not settled by its due date
--                  (0 = no late fee; this is what the loan's agreement will state)
--   late_fee_from  optional: only cycles due on/after this date are charged, so a fee
--                  agreed today is not applied to months that were already past
-- ============================================================
alter table loans add column if not exists late_fee numeric(12,2) not null default 0;
alter table loans add column if not exists late_fee_from date;
