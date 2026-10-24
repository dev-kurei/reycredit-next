-- ============================================================
-- REY CREDIT -- what the bank / credit card charges YOU for each loan (admin only)
-- Paste into the Supabase SQL editor and run once.
--   bank_monthly  the monthly amount you pay the bank for this loan
--   bank_fee      one-time fee the bank charged you (0 if none)
--   bank_terms    how many months you pay the bank (blank = same as the loan's terms)
-- Borrowers never see these; they are used only for your profit figures.
-- ============================================================
alter table loans add column if not exists bank_monthly numeric(12,2) not null default 0;
alter table loans add column if not exists bank_fee numeric(12,2) not null default 0;
alter table loans add column if not exists bank_terms int;
