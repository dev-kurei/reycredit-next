const Module = require('module');
const { makeFakeDb } = require('./fake-supabase.js');

const tables = {
  borrowers: [
    { id: 1, name: "John A.", email: "j@x.com", contact: "0917", address: "", valid_id: "", cc_email: "" },
    { id: 2, name: "Venah P.", email: "v@x.com", contact: "0918", address: "", valid_id: "", cc_email: "" },
  ],
  banks: [
    { id: 1, name: "BPI Blue Rewards", statement_day: 25, due_day: 8, due_month: "Next Month" },
  ],
  loans: [
    { id: 10, borrower_id: 1, loan_name: "Credit-To-Cash (15K)", loan_type: "Cash Loan", start_date: "2026-04-29",
      principal: 15000, terms: 6, monthly_rate: 0.79, processing_fee: 300, total_interest: 711, total_payable: 16011,
      monthly_amort: 2618.50, bank_id: 1, due_day: 8, closed: false },
    { id: 20, borrower_id: 2, loan_name: "Airline Tickets", loan_type: "Item Loan", start_date: "2026-02-12",
      principal: 12807, terms: 6, monthly_rate: 0.49, processing_fee: 900, total_interest: 376.53, total_payable: 14083.53,
      monthly_amort: 13183.53, bank_id: null, due_day: 24, closed: false },
  ],
  payments: [
    { id: 1, loan_id: 10, for_month: "June 2026", amount: 2695, paid_date: "2026-06-08", receipt_no: "R1", method: "GCash" },
    { id: 2, loan_id: 10, for_month: "July 2026", amount: 2668.50, paid_date: "2026-07-10", receipt_no: "R2", method: "GCash" },
    { id: 3, loan_id: 10, for_month: "August 2026", amount: 2968, paid_date: "2026-08-07", receipt_no: "R3", method: "GCash" },
    { id: 4, loan_id: 10, for_month: "September 2026", amount: 7679.50, paid_date: "2026-08-10", receipt_no: "R4", method: "GCash" },
  ],
  users: [
    { id: 1, email: "admin@x.com", password_hash: require('bcryptjs').hashSync('secret123', 10), role: "ADMIN" },
  ],
  email_log: [], config: [
    { key: "COMPANY_NAME", value: "Rey Credit" }, { key: "PENALTY_RATE", value: "3" },
    { key: "SUPPORT_EMAIL", value: "b@x.com" }, { key: "SUPPORT_PHONE", value: "0968" },
    { key: "COMPANY_ADDR", value: "Rizal" }, { key: "LOGO_URL", value: "" }, { key: "LENDER_SIG_URL", value: "" },
    { key: "LENDER_NAME", value: "Rey F.P." }, { key: "LENDER_ADDR", value: "Rizal" }, { key: "PORTAL_URL", value: "https://x" },
    { key: "GCASH_ACCOUNT", value: "0968" }, { key: "BPI_ACCOUNT", value: "065" }, { key: "MARIBANK_ACCOUNT", value: "171" },
    { key: "OFFICE_HOURS", value: "Mon-Sat" },
  ],
};
const fakeDb = makeFakeDb(tables);

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith('/supabase') || request === './supabase') return { db: () => fakeDb };
  if (request.endsWith('/mailer') || request === './mailer') return { sendMail: async () => ({ success: true }) };
  return origLoad.apply(this, arguments);
};

const fns = require('../lib/functions.js');

(async () => {
  console.log("=== getConfig ===");
  console.log(await fns.getConfig());

  console.log("\n=== validateLogin (correct + wrong) ===");
  console.log(await fns.validateLogin("admin@x.com", "secret123"));
  console.log(await fns.validateLogin("admin@x.com", "wrong"));

  console.log("\n=== getAdminBorrowerList ===");
  console.log(await fns.getAdminBorrowerList());

  console.log("\n=== getAdminBorrowerDetail(10) — John A., should show 0 balance, null next bill ===");
  const detail = await fns.getAdminBorrowerDetail(10);
  console.log({ balance: detail.balance, status: detail.status, nextBillDetails: detail.nextBillDetails, remaining: detail.remaining });

  console.log("\n=== getAdminBorrowerDetail(20) — Venah, terms mismatch must be flagged ===");
  const venah = await fns.getAdminBorrowerDetail(20);
  console.log({ balance: venah.balance, termsMismatch: venah.termsMismatch, impliedAmort: venah.impliedAmort, monthlyAmort: venah.monthlyAmort });

  console.log("\n=== auditLoanTerms ===");
  console.log(await fns.auditLoanTerms());

  console.log("\n=== recordPayment on loan 10 (adds a tiny final payment) ===");
  const rp = await fns.recordPayment(10, "November 2026", 12.12, "09/18/2026", "", "Other");
  console.log({ success: rp.success, status: rp.status, balance: rp.balance, receiptSent: rp.receiptSent });

  console.log("\n=== getCreditScores ===");
  const scores = await fns.getCreditScores();
  console.log(scores.borrowers.map(b => ({ name: b.name, score: b.score, grade: b.grade })));

  console.log("\n=== getLendingGuide for John ===");
  console.log(await fns.getLendingGuide("j@x.com"));

  console.log("\n=== getDocumentHtml (soa) — just confirm it renders without throwing ===");
  const doc = await fns.getDocumentHtml(10, "soa");
  console.log({ success: doc.success, htmlLength: doc.html ? doc.html.length : 0 });

  console.log("\n=== NEW: wildcard emails must not match ===");
  console.log("login with '%'      ->", await fns.validateLogin("%", "secret123"));
  console.log("reset for '%'       ->", await fns.resetPasswordToDefault("%"));
  console.log("borrower data '%'   ->", (await fns.getBorrowerData("%")).length, "loans (expect 0)");

  console.log("\n=== NEW: settled loans excluded from reminders/statements ===");
  const rem = await fns.runDueReminders();
  console.log("reminders sent for:", rem.map(r => r.loan), "(John=10 is settled, must NOT appear)");

  console.log("\n=== NEW: closed derived from ledger (John settled -> counted as closed) ===");
  const cs = await fns.getCreditScore("j@x.com");
  console.log("closedLoans:", cs.closedLoans, "activeLoans:", cs.activeLoans, "(expect 1 / 0)");

  console.log("\nALL SMOKE TESTS COMPLETED WITHOUT THROWING");
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
