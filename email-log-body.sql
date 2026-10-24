-- ============================================================
-- REY CREDIT -- keep the email body in the Email log
-- Paste into the Supabase SQL editor and run once.
-- Adds two columns so the Email log page can show exactly what was sent.
-- Only emails sent AFTER this is run (and the update deployed) have a body.
-- ============================================================
alter table email_log add column if not exists body_html text;
alter table email_log add column if not exists attachment_names text default '';
