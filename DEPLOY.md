# Rey Credit — Supabase + Vercel deployment

You can deploy from your terminal (section 3) or let Vercel deploy automatically every time you push to GitHub (section 3b). You need Node 20 or newer.

## 1. Supabase (the database)
1. supabase.com → **New project**. Save the database password somewhere.
2. **SQL Editor → New query** → paste all of `supabase-schema.sql` → **Run**.
3. **Project Settings → API**: copy the **Project URL** and the **service_role** key.
4. **Create your first admin.** No login is seeded, because this repository is public. On your computer,
   in the project folder after `npm install`, make a password hash (put your own strong password inside the quotes):
   ```bash
   node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" "YOUR-STRONG-PASSWORD"
   ```
   Copy the long text it prints (it starts with `$2a$10$`). Then in the Supabase **SQL Editor** run, using your
   own email and that hash:
   ```sql
   insert into users (email, password_hash, role)
   values ('you@email.com', 'PASTE-THE-HASH-HERE', 'ADMIN');
   ```
   Never save the password or the hash in the project folder or in Git.

## 2. Resend (the sender)
1. resend.com -> sign up -> **Domains -> Add** -> enter your domain (e.g. `reycredits.com`).
2. Add the DNS records Resend shows you, at whichever host manages your domain's DNS
   (Cloudflare, etc). These are SPF/DKIM records, separate from any MX records a mailbox
   like Zoho Mail already uses on the same domain -- sending and receiving don't conflict.
3. Wait for Resend to mark the domain **Verified** (usually a few minutes).
4. **API Keys -> Create API Key** -> copy it.
5. Decide the address mail will come from, e.g. `billing@reycredits.com` -- it does not need
   to be a real inbox; Resend only needs the domain verified, not that specific mailbox.

## 3. Deploy with the Vercel CLI
```bash
npm i -g vercel
vercel login                 # choose "Continue with Email" — GitHub is not needed
cd reycredit-next
npm install
vercel link                  # answer the prompts; this creates the project
```
Add the variables (each command asks you to paste the value):
```bash
vercel env add SUPABASE_URL production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add SESSION_SECRET production
vercel env add CRON_SECRET production
vercel env add RESEND_API_KEY production
vercel env add RESEND_FROM_EMAIL production
vercel env add LENDER_SIGNATURE_DATA_URI production
```
`LENDER_SIGNATURE_DATA_URI` is your signature as a `data:image/png;base64,...` text. It is optional (without it
the agreement has a blank signature line). It is kept here, not in the repository, because the repository is public.
Keep the text file you generated it from somewhere private, outside the project folder.

Then ship it:
```bash
vercel --prod
```
Every later change is just `vercel --prod` again.

## 3b. Automatic deploys from GitHub (optional, replaces `vercel --prod`)
1. Push the project to a GitHub repository (the `.gitignore` already keeps `.env*`, `node_modules`, `.vercel`,
   exports and the local signature file out of it).
2. Vercel → your project → **Settings → Git → Connect Git Repository** → choose the repo.
3. Make sure all the environment variables above are set under **Settings → Environment Variables**
   (they live in Vercel, not in GitHub).
4. From then on `git add .`, `git commit -m "..."`, `git push` deploys to production automatically.
   Pushes to other branches create preview deployments.
5. SQL files (`late-fee.sql`, `bank-cost.sql`, ...) are never run by a deploy. Run them yourself in the Supabase
   SQL Editor **before** pushing code that needs the new columns.

## 4. Move your existing data
1. In the Google Sheet, for each tab: **File → Download → CSV**. Name them exactly
   `Master_Database.csv`, `Payment_History.csv`, `Users.csv`, `Banks.csv`, `Config.csv`
   and put them in a folder called `export`.
2. Make a file `.env.local` containing just `SUPABASE_URL=` and `SUPABASE_SERVICE_ROLE_KEY=`.
3. Rehearse — writes nothing, just tells you what it found:
   ```bash
   node scripts/migrate-from-sheets.js --dir ./export --dry-run
   ```
4. Run it for real (it refuses to run if the database already has loans, so it can't double-import):
   ```bash
   node --env-file=.env.local scripts/migrate-from-sheets.js --dir ./export
   ```
   Old plaintext passwords are hashed on the way in; borrowers keep the password they had.
5. Open the app → **Settings → Data health → Run check** → Apply. This fixes loans whose monthly
   amortization was typed as the total.

## 5. Before you tell anyone it's live
- **Check there is no default login.** Older copies of `supabase-schema.sql` seeded `admin@reycredit.local` with a
  published password. If your database was set up from one, delete it once your *own* admin login works:
  `delete from users where email = 'admin@reycredit.local';`
- **Settings → Business:** set Portal URL to your new Vercel address, and point your tinyurl at it.
- Send yourself a test: record a payment on a test borrower and check the receipt arrives.

## What changed from the Apps Script version
| Before | Now |
|---|---|
| Balance/status stored in sheet cells, refreshed by `refreshAllStatuses` | Always computed live from the payment ledger. Nothing to refresh, nothing to go stale. |
| `installTriggers` | One daily job in `vercel.json` (9:00 Manila) runs reminders + statements. Nothing to install. |
| Anyone with the URL could call any function | Server checks a signed session: borrowers reach only their own data, everything else is admin-only. |
| Plaintext passwords in a sheet | bcrypt hashes. |
| Payments matched to loans by typed name | Payments hold the loan's id — renaming a loan can't orphan its history. |
| Agreement/SOA attached as PDF | Real PDFs again, generated with @react-pdf/renderer (no headless-Chromium dependency, which doesn't fit comfortably in a serverless function). The in-app "view in browser" version stays a styled HTML page with a Print button; only the email attachment changed. |

## Known limits — worth knowing, not blocking
- **Password reset** still overwrites the account's password the moment someone asks for a PIN, so anyone who
  knows an email can force that person to use the emailed PIN. Same as the old system. Fix later with a
  separate expiring reset code.
- **No login rate-limiting.** Add Vercel's firewall rate limit on `/api/rpc` if you want it.
- **Vercel's free Hobby plan is for personal, non-commercial use.** A lending business likely needs Pro — check
  their current terms before relying on it.
- Resend's free tier caps out at 100 emails/day (3,000/month) -- comfortable for this portfolio's size, but worth watching if the borrower list grows a lot.

## Tests
`npm test` runs the loan-engine regression cases (the A., Venah, Glenn and Rey incidents) and an end-to-end
pass against an in-memory database. Run it before any `vercel --prod` that touches `lib/`.
