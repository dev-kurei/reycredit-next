/*  ============================================================
    RPC function registry — one function per old Code.gs entry point,
    now backed by Supabase instead of a spreadsheet.
    Every function here has the exact name the front-end already calls,
    so /public/index.html needed zero changes beyond the RPC transport.
    ============================================================ */
const { db } = require("./supabase");
const { hashPassword, verifyPassword } = require("./auth");
const {
  MONTHS, round2, day0, today, fmtDate, peso, monthsBetween,
  buildSchedule, balanceFrom, remainingFrom, nextBillFrom, statusFrom, statusLabel, owedToday,
  liveLoanFigures, scoreBorrower, lendingGuide, monthKeyFrom,
} = require("./engine");

// sendMail, email-templates, documents (HTML) and pdf-documents are required
// lazily, inside the specific functions that use them, rather than up here.
// Most RPC calls -- signing in, listing borrowers, credit scores, reports --
// never touch email or PDF generation at all, so loading the Resend SDK and
// the PDF renderer (which pulls in @react-pdf/renderer and ~50KB of embedded
// logo/signature image data) for every single cold start was pure overhead
// on the majority of requests. A lazy require() only pays that cost on the
// requests that actually need it, and only once per warm instance after that
// (Node caches the module after its first load).

/** Emails are stored lowercase and matched exactly. A pattern match would treat % and _ as
 *  wildcards, so john_doe@x.com would also match johnXdoe@x.com. */
const norm = (e) => String(e || "").trim().toLowerCase();

/**
 * Records every email the app sends — independent of Resend's own 30-day
 * dashboard retention, and reachable from inside the app via
 * getEmailLog() instead of needing to open Resend at all. Never allowed to
 * throw: a logging failure must not take down the email it is logging.
 */
async function logEmail({ loanId, borrowerName, to, cc, type, subject, result, html, attachments }) {
  try {
    const row = {
      loan_id: loanId || null, borrower_name: borrowerName || "", to_email: to || "",
      cc_email: cc || "", email_type: type, subject: subject || "",
      status: result.success ? "sent" : "failed", error_message: result.success ? "" : (result.msg || ""),
      resend_id: result.id || "",
    };
    // The body is kept so the Email log can show exactly what was sent. A password-reset email
    // carries the new PIN in plain text, so its body is never stored.
    const keepBody = html && type !== "reset_pin";
    const withBody = { ...row };
    if (keepBody) withBody.body_html = String(html);
    if (attachments && attachments.length) withBody.attachment_names = attachments.map((a) => a.filename).join(" | ");
    const { error } = await db().from("email_log").insert(withBody);
    // Until email-log-body.sql has been run the new columns don't exist; still record the send.
    if (error && withBody !== row && /body_html|attachment_names|column/i.test(error.message || "")) {
      await db().from("email_log").insert(row);
    }
  } catch (e) { /* logging never blocks the actual send */ }
}

/* ---------------- config ---------------- */
const DEFAULT_CONFIG = {
  COMPANY_NAME: "Rey Credit", LENDER_NAME: "Your Name",
  SUPPORT_EMAIL: "billing@example.com", SUPPORT_PHONE: "09XXXXXXXXX",
  COMPANY_ADDR: "Your city, Province", LENDER_ADDR: "Your street, city, Province",
  LOGO_URL: "", LENDER_SIG_URL: "",
  PORTAL_URL: "", DOMAIN_URL: "", GCASH_ACCOUNT: "09XXXXXXXXX",
  BPI_ACCOUNT: "", MARIBANK_ACCOUNT: "",
  PENALTY_RATE: "3", LATE_FEE_DEFAULT: "0", OFFICE_HOURS: "Mon – Sat, 8AM – 5PM",
};

async function getConfig() {
  const { data, error } = await db().from("config").select("key,value");
  if (error) throw new Error(error.message);
  const cfg = { ...DEFAULT_CONFIG };
  for (const row of data || []) if (row.value != null) cfg[row.key] = row.value;
  return cfg;
}
async function saveConfig(patch) {
  const rows = Object.keys(patch).map((key) => ({ key, value: String(patch[key] ?? "") }));
  const { error } = await db().from("config").upsert(rows, { onConflict: "key" });
  return error ? { success: false, msg: error.message } : { success: true };
}
async function resetConfigToDefaults() {
  const rows = Object.keys(DEFAULT_CONFIG).map((key) => ({ key, value: DEFAULT_CONFIG[key] }));
  const { error } = await db().from("config").upsert(rows, { onConflict: "key" });
  return error ? { success: false, msg: error.message } : { success: true, cfg: DEFAULT_CONFIG };
}

/* ---------------- banks ---------------- */
async function getBankList() {
  const { data, error } = await db().from("banks").select("*").order("name");
  if (error) throw new Error(error.message);
  return (data || []).map((b) => ({ row: b.id, bank: b.name, statementDay: b.statement_day, dueDay: b.due_day, dueMonth: b.due_month }));
}
async function addBankEntry(d) {
  const { error } = await db().from("banks").insert({
    name: d.bank, statement_day: Number(d.statementDay) || 1, due_day: Number(d.dueDay) || 1, due_month: d.dueMonth || "Next Month",
  });
  return error ? { success: false, msg: error.message } : { success: true };
}
async function updateBankEntry(row, d) {
  const { error } = await db().from("banks").update({
    name: d.bank, statement_day: Number(d.statementDay) || 1, due_day: Number(d.dueDay) || 1, due_month: d.dueMonth || "Next Month",
  }).eq("id", row);
  return error ? { success: false, msg: error.message } : { success: true };
}
async function deleteBankEntry(row) {
  const { error } = await db().from("banks").delete().eq("id", row);
  return error ? { success: false, msg: error.message } : { success: true };
}
async function bankByName(name) {
  if (!name) return null;
  const { data } = await db().from("banks").select("*").eq("name", name).maybeSingle();
  if (!data) return null;
  return { id: data.id, statementDay: data.statement_day, dueDay: data.due_day, sameMonth: (data.due_month || "").toLowerCase().includes("same") };
}

/* ---------------- users / auth ---------------- */

/** Portal PINs are 4 digits, so they are only safe together with the lockout below.
 *  Random, and never an obvious one (1234, 0000, 1111, 1212, 4321 ...). */
function isWeakPin(p) {
  if (/^(\d)\1{3}$/.test(p) || /^(\d\d)\1$/.test(p)) return true;
  return ["0123", "1234", "2345", "3456", "4567", "5678", "6789", "3210", "4321", "5432", "6543", "7654", "8765", "9876", "2580", "1004"].includes(p);
}
function randomPin() {
  const crypto = require("crypto");
  for (;;) {
    const p = String(crypto.randomInt(0, 10000)).padStart(4, "0");
    if (!isWeakPin(p)) return p;
  }
}

/* Lockout: 5 wrong passwords for an account locks it for 15 minutes (counting restarts after 30 quiet
 * minutes). Stored in login_attempts (login-lockout.sql). If that table has not been created yet the
 * checks quietly do nothing, so sign-in keeps working -- but run the SQL: without the lockout a 4-digit
 * PIN can be guessed. Resets for the same account are limited to 3 an hour. */
const LOGIN_MAX_FAILS = 5, LOGIN_LOCK_MIN = 15, LOGIN_FAIL_MEMORY_MIN = 30, RESET_MAX_PER_HOUR = 3;
async function attemptRow(email) {
  try { const { data, error } = await db().from("login_attempts").select("*").eq("email", email).maybeSingle(); return error ? null : data || null; }
  catch (e) { return null; }
}
async function saveAttempt(email, existing, patch) {
  try {
    if (existing) await db().from("login_attempts").update(patch).eq("email", email);
    else await db().from("login_attempts").insert({ email, ...patch });
  } catch (e) { /* table missing: no lockout, sign-in still works */ }
}
function minutesLeft(iso) { return Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 60000)); }

async function validateLogin(email, pass) {
  if (!email || !pass) return { success: false };
  const e = norm(email);
  const att = await attemptRow(e);
  if (att && att.locked_until && new Date(att.locked_until).getTime() > Date.now()) {
    const m = minutesLeft(att.locked_until);
    return { success: false, locked: true, msg: `Too many wrong attempts. Try again in ${m} minute${m === 1 ? "" : "s"}, or use Forgot password.` };
  }
  const { data } = await db().from("users").select("*").eq("email", e).maybeSingle();
  if (!data) return { success: false };
  if (!verifyPassword(pass, data.password_hash)) {
    const recent = att && att.last_failure && (Date.now() - new Date(att.last_failure).getTime()) < LOGIN_FAIL_MEMORY_MIN * 60000;
    const fails = (recent ? Number(att.failures) || 0 : 0) + 1;
    const lock = fails >= LOGIN_MAX_FAILS;
    await saveAttempt(e, att, { failures: lock ? 0 : fails, last_failure: new Date().toISOString(), locked_until: lock ? new Date(Date.now() + LOGIN_LOCK_MIN * 60000).toISOString() : null });
    if (lock) return { success: false, locked: true, msg: `Too many wrong attempts. Try again in ${LOGIN_LOCK_MIN} minutes, or use Forgot password.` };
    return { success: false };
  }
  if (att && (att.failures || att.locked_until)) await saveAttempt(e, att, { failures: 0, last_failure: null, locked_until: null });
  return { success: true, email: data.email, role: data.role };
}
async function changeUserPassword(email, newPass) {
  if (!email) return "Error: No email provided.";
  const { error } = await db().from("users").update({ password_hash: hashPassword(newPass) }).eq("email", norm(email));
  return error ? "Error: " + error.message : "Success";
}
const RESET_SENT = { success: true, msg: "If that email has an account, a new PIN is on its way." };
async function resetPasswordToDefault(email) {
  if (!email) return { success: false, msg: "Enter your email address." };
  const e = norm(email);
  const { data: user } = await db().from("users").select("*").eq("email", e).maybeSingle();
  if (!user) return RESET_SENT;                      // same answer whether or not the account exists
  // At most 3 resets an hour per account, so this cannot be used to keep overwriting someone's password.
  const att = await attemptRow(e);
  const windowOpen = att && att.reset_window_start && (Date.now() - new Date(att.reset_window_start).getTime()) < 3600000;
  const used = windowOpen ? Number(att.resets) || 0 : 0;
  if (used >= RESET_MAX_PER_HOUR) return { success: false, msg: "Too many reset requests. Please try again in an hour." };
  await saveAttempt(e, att, { resets: used + 1, reset_window_start: windowOpen ? att.reset_window_start : new Date().toISOString() });
  // Admin passwords are never reset by email (anyone who knew the address could otherwise attack the admin login).
  // The owner changes it in the Supabase table editor, or signs in and uses Change password.
  if (user.role === "ADMIN") return RESET_SENT;
  await setPinAndEmail(user, { forced: false });
  await saveAttempt(e, await attemptRow(e), { failures: 0, last_failure: null, locked_until: null });
  return RESET_SENT;
}
/** Sets a fresh random PIN and emails it. The PIN itself is never stored in the email log. */
async function setPinAndEmail(user, { forced }) {
  const pin = randomPin();
  await db().from("users").update({ password_hash: hashPassword(pin) }).eq("id", user.id);
  const { data: borrower } = await db().from("borrowers").select("name").eq("email", user.email).maybeSingle();
  const cfg = await getConfig();
  try {
    const { sendMail } = require("./mailer");
    const templates = require("./email-templates");
    const mail = templates.resetPinEmail(cfg, { name: borrower?.name, email: user.email, pin, forced });
    const result = await sendMail({ to: user.email, subject: mail.subject, html: mail.html, fromName: cfg.COMPANY_NAME });
    await logEmail({ borrowerName: borrower?.name, to: user.email, type: "reset_pin", subject: mail.subject, result });
    return { pin, sent: !!(result && result.success) };
  } catch (err) { return { pin, sent: false }; }
}

/** Borrowers still on the old default password 1234 (the only weak password this app ever handed out). */
async function auditWeakPasswords() {
  const { data, error } = await db().from("users").select("*").eq("role", "BORROWER");
  if (error) return { success: false, msg: error.message };
  const weak = (data || []).filter((u) => verifyPassword("1234", u.password_hash));
  const { data: bs } = await db().from("borrowers").select("name,email");
  const nameBy = new Map((bs || []).map((b) => [norm(b.email), b.name]));
  return { success: true, count: weak.length, total: (data || []).length, users: weak.map((u) => ({ email: u.email, name: nameBy.get(norm(u.email)) || "" })) };
}
/** Gives each of those borrowers a random PIN and emails it to them. */
async function resetWeakPasswords() {
  const { data, error } = await db().from("users").select("*").eq("role", "BORROWER");
  if (error) return { success: false, msg: error.message };
  let done = 0, emailed = 0; const failed = [];
  for (const u of data || []) {
    if (!verifyPassword("1234", u.password_hash)) continue;
    const r = await setPinAndEmail(u, { forced: true });
    done++; if (r.sent) emailed++; else failed.push(u.email);
  }
  return { success: true, changed: done, emailed, failed };
}
async function getUsersList() {
  const { data, error } = await db().from("users").select("*").order("email");
  if (error) throw new Error(error.message);
  return (data || []).map((u) => ({ row: u.id, email: u.email, password: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", role: u.role }));
}
async function updateUserAdmin(row, d) {
  const patch = {};
  if (d.email) patch.email = norm(d.email);
  if (d.password) patch.password_hash = hashPassword(d.password);
  if (d.role) patch.role = d.role;
  const { error } = await db().from("users").update(patch).eq("id", row);
  return error ? { success: false, msg: error.message } : { success: true };
}

/* ---------------- data loading helpers ---------------- */

/** Every bank, keyed by id, loaded once per request. */
async function allBanksById() {
  const { data } = await db().from("banks").select("*");
  const map = new Map();
  for (const b of data || []) {
    map.set(b.id, { statementDay: b.statement_day, dueDay: b.due_day, sameMonth: (b.due_month || "").toLowerCase().includes("same"), name: b.name });
  }
  return map;
}

/** Maps a `loans` row (plus its bank) into the shape engine.js expects. */
function toEngineLoan(loanRow, banksById) {
  return {
    id: loanRow.id,
    startDate: new Date(loanRow.start_date),
    totalPayable: Number(loanRow.total_payable),
    terms: Number(loanRow.terms),
    monthlyAmort: Number(loanRow.monthly_amort),
    processingFee: Number(loanRow.processing_fee),
    bankMonthly: Number(loanRow.bank_monthly) || 0, bankFee: Number(loanRow.bank_fee) || 0, bankTerms: Number(loanRow.bank_terms) || 0,
    principal: Number(loanRow.principal) || 0,
    totalInterest: Number(loanRow.total_interest) || 0,
    bank: loanRow.bank_id ? banksById.get(loanRow.bank_id) || null : null,
    dueDay: loanRow.due_day || 1,
    loanName: loanRow.loan_name,
    lateFee: Number(loanRow.late_fee) || 0,
    lateFeeFrom: loanRow.late_fee_from ? new Date(loanRow.late_fee_from) : null,
  };
}

/** All payments for one loan, shaped for the engine. */
async function paymentsForLoan(loanId) {
  const { data } = await db().from("payments").select("*").eq("loan_id", loanId).order("paid_date");
  return (data || []).map((p) => ({ month: p.for_month, amount: Number(p.amount), date: p.paid_date ? new Date(p.paid_date) : null, receiptNo: p.receipt_no, method: p.method }));
}

/** All payments for a set of loan ids in one query, grouped by loan_id. */
async function paymentsForLoans(loanIds) {
  const map = new Map();
  if (!loanIds.length) return map;
  const { data } = await db().from("payments").select("*").in("loan_id", loanIds).order("paid_date");
  for (const p of data || []) {
    const arr = map.get(p.loan_id) || [];
    arr.push({ month: p.for_month, amount: Number(p.amount), date: p.paid_date ? new Date(p.paid_date) : null, receiptNo: p.receipt_no, method: p.method });
    map.set(p.loan_id, arr);
  }
  return map;
}

async function loanWithBorrower(loanId) {
  const { data, error } = await db().from("loans").select("*, borrowers(*)").eq("id", loanId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Builds the full "loan detail" payload the loan page and portal expect. */
async function loanPayload(loanRow, banksById, penaltyRate, opts) {
  const admin = !!(opts && opts.admin);
  const borrower = loanRow.borrowers;
  const engineLoan = toEngineLoan(loanRow, banksById);
  const payments = await paymentsForLoan(loanRow.id);
  const fig = liveLoanFigures(engineLoan, payments, penaltyRate);
  const bank = loanRow.bank_id ? banksById.get(loanRow.bank_id) : null;

  return {
    rowIndex: loanRow.id,
    borrowerName: borrower.name, email: borrower.email,
    loanName: loanRow.loan_name, loanType: loanRow.loan_type || (loanRow.loan_name.toLowerCase().includes("cash") ? "Cash Loan" : "Item Loan"),
    startDate: fmtDate(loanRow.start_date, "MMMM dd, yyyy"), startDateISO: fmtDate(loanRow.start_date, "yyyy-MM-dd"),
    totalPayable: Number(loanRow.total_payable), originalAmount: Number(loanRow.principal), terms: Number(loanRow.terms),
    monthlyRate: `${Number(loanRow.monthly_rate).toFixed(2)}%`, effectiveRate: `${(Number(loanRow.monthly_rate) * 12).toFixed(2)}%`,
    totalInterest: Number(loanRow.total_interest), processingFee: Number(loanRow.processing_fee),
    lateFee: Number(loanRow.late_fee) || 0, lateFeeFromISO: loanRow.late_fee_from ? fmtDate(loanRow.late_fee_from, "yyyy-MM-dd") : "",
    money: fig.money,
    // Your own cost and profit: admin only, never in what a borrower is sent.
    ...(admin ? { profit: fig.profit, bankMonthly: Number(loanRow.bank_monthly) || 0, bankFee: Number(loanRow.bank_fee) || 0, bankTerms: Number(loanRow.bank_terms) || 0 } : {}),
    amountPaid: fig.paid, balance: fig.balance, monthlyAmort: Number(loanRow.monthly_amort), remaining: fig.remaining,
    status: fig.statusText, partner: bank?.name || "", bank: bank?.name || "", dueDay: loanRow.due_day || 1,
    nextDueDate: fig.next ? fig.next.dueDate : "",
    address: borrower.address || "", validId: borrower.valid_id || "", contactNumber: borrower.contact || "", ccEmail: borrower.cc_email || "",
    nextBillDetails: fig.next, arrears: fig.arrears, termsMismatch: fig.termsMismatch, expectedPayable: fig.expectedPayable, impliedAmort: fig.impliedAmort,
    history: payments.map((p, i) => {
      const a = fig.money.applied.find((x) => x.index === i);
      return { month: p.month, amount: p.amount, date: p.date ? fmtDate(p.date, "MM/dd/yyyy") : "", receiptNo: p.receiptNo, toCharges: a ? a.toCharges : 0, toInstalments: a ? a.toInstalments : p.amount };
    }),
  };
}

/* ---------------- borrower list / detail ---------------- */

async function getAdminBorrowerList() {
  const cfg = await getConfig();
  const banksById = await allBanksById();
  const { data: loans, error } = await db().from("loans").select("*, borrowers(*)").order("id");
  if (error) throw new Error(error.message);
  const ids = (loans || []).map((l) => l.id);
  const paymentsMap = await paymentsForLoans(ids);
  const penaltyRate = Number(cfg.PENALTY_RATE) || 0;

  return (loans || []).map((l) => {
    const engineLoan = toEngineLoan(l, banksById);
    const fig = liveLoanFigures(engineLoan, paymentsMap.get(l.id) || [], penaltyRate);
    const bank = l.bank_id ? banksById.get(l.bank_id) : null;
    return {
      rowIndex: l.id, name: l.borrowers.name, email: l.borrowers.email, loan: l.loan_name,
      balance: peso(fig.balance), monthlyAmort: peso(l.monthly_amort), status: fig.statusText,
      bank: bank?.name || "", nextDue: fig.next ? fig.next.dueDate : "",
    };
  });
}

async function getAdminBorrowerDetail(rowIndex) {
  try {
    const cfg = await getConfig();
    const banksById = await allBanksById();
    const loanRow = await loanWithBorrower(rowIndex);
    if (!loanRow) return { error: "Loan not found." };
    return await loanPayload(loanRow, banksById, Number(cfg.PENALTY_RATE) || 0, { admin: true });
  } catch (e) { return { error: e.message }; }
}

async function getBorrowerData(email) {
  if (!email) return [];
  const cfg = await getConfig();
  const banksById = await allBanksById();
  const { data: borrower } = await db().from("borrowers").select("*").eq("email", norm(email)).maybeSingle();
  if (!borrower) return [];
  const { data: loans } = await db().from("loans").select("*, borrowers(*)").eq("borrower_id", borrower.id).order("id");
  const out = [];
  for (const l of loans || []) out.push(await loanPayload(l, banksById, Number(cfg.PENALTY_RATE) || 0));
  return out;
}

async function getBorrowerPersonalDetails(email) {
  if (!email) return { success: false, msg: "No email provided." };
  const { data } = await db().from("borrowers").select("*, loans(bank_id)").eq("email", norm(email)).maybeSingle();
  if (!data) return { success: false, msg: "Borrower not found." };
  const banksById = await allBanksById();
  const bankId = data.loans?.[0]?.bank_id;
  return {
    success: true, name: data.name, email: data.email, address: data.address || "",
    validId: data.valid_id || "", contactNumber: data.contact || "", bank: bankId ? (banksById.get(bankId)?.name || "") : "",
  };
}

async function getPortalInfo() {
  const c = await getConfig();
  return {
    companyName: c.COMPANY_NAME, lenderName: c.LENDER_NAME, supportEmail: c.SUPPORT_EMAIL, supportPhone: c.SUPPORT_PHONE,
    address: c.COMPANY_ADDR, hours: c.OFFICE_HOURS, logo: c.LOGO_URL, gcash: c.GCASH_ACCOUNT, bpi: c.BPI_ACCOUNT,
    maribank: c.MARIBANK_ACCOUNT, penaltyRate: Number(c.PENALTY_RATE) || 0,
  };
}

/* ---------------- create / update / delete ---------------- */

async function resolveBank(nameOrEmpty) {
  if (!nameOrEmpty) return { bankId: null, dueDay: 1 };
  const b = await bankByName(nameOrEmpty);
  return b ? { bankId: b.id, dueDay: b.dueDay } : { bankId: null, dueDay: 1 };
}

function loanFieldsFromForm(d, bankId, dueDay) {
  return {
    loan_name: d.loanName || d.loanType, loan_type: d.loanType || "",
    start_date: d.startDate, principal: d.principal, terms: d.terms,
    monthly_rate: d.rate, processing_fee: d.fee || 0, total_interest: d.totalInterest,
    total_payable: d.totalPayable, monthly_amort: d.monthlyAmort,
    bank_id: bankId, due_day: Number(d.dueDay) || dueDay || 1,
  };
}

/**
 * Stores a loan's flat late payment fee. Kept apart from the main save so a database that has not
 * had late-fee.sql run yet still saves everything else; only an actual late fee needs the columns.
 *   - A fee on a NEW loan applies to every cycle (it is in the agreement from day one).
 *   - A fee added to an EXISTING loan applies from today unless a start date is given, so months
 *     that were already past are not charged retroactively by accident.
 */
async function saveLateFee(loanId, d, existingRow) {
  const fee = Math.max(0, round2(d.lateFee));
  const had = existingRow ? Number(existingRow.late_fee) || 0 : 0;
  if (!fee && !had) return { ok: true };
  const patch = { late_fee: fee };
  if (!fee) patch.late_fee_from = null;
  else if (d.lateFeeFrom) patch.late_fee_from = String(d.lateFeeFrom).slice(0, 10);
  else if (existingRow && !had) patch.late_fee_from = fmtDate(today(), "yyyy-MM-dd");
  else if (!existingRow) patch.late_fee_from = null;
  const { error } = await db().from("loans").update(patch).eq("id", loanId);
  if (error) {
    return { ok: false, msg: /late_fee/i.test(error.message)
      ? "The loan was saved, but the late fee was not: run late-fee.sql in the Supabase SQL editor first, then set the late fee again."
      : error.message };
  }
  return { ok: true };
}

/**
 * Stores what the bank charges you for a loan (admin only). Separate from the main save, like the
 * late fee, so a database that has not had bank-cost.sql run yet still saves everything else.
 */
async function saveBankCost(loanId, d, existingRow) {
  // A form that has no bank-cost fields (editing a loan) leaves a saved bank cost alone.
  if (d.bankMonthly === undefined && d.bankFee === undefined && d.bankTerms === undefined) return { ok: true };
  const monthly = Math.max(0, round2(d.bankMonthly)), oneTime = Math.max(0, round2(d.bankFee));
  const terms = Math.max(0, parseInt(d.bankTerms, 10) || 0);
  const had = existingRow ? (Number(existingRow.bank_monthly) || 0) + (Number(existingRow.bank_fee) || 0) + (Number(existingRow.bank_terms) || 0) : 0;
  if (!monthly && !oneTime && !terms && !had) return { ok: true };
  const { error } = await db().from("loans").update({ bank_monthly: monthly, bank_fee: oneTime, bank_terms: terms || null }).eq("id", loanId);
  if (error) {
    return { ok: false, msg: /bank_(monthly|fee|terms)/i.test(error.message)
      ? "The loan was saved, but the bank cost was not: run bank-cost.sql in the Supabase SQL editor first, then enter it again."
      : error.message };
  }
  return { ok: true };
}

/** Saves only the bank cost; never touches the loan's terms, totals or what the borrower owes. */
async function setBankCost(rowIndex, monthly, fee, terms) {
  try {
    const loanRow = await loanWithBorrower(rowIndex);
    if (!loanRow) return { success: false, msg: "Loan not found." };
    const r = await saveBankCost(rowIndex, { bankMonthly: monthly, bankFee: fee, bankTerms: terms }, loanRow);
    if (!r.ok) return { success: false, msg: r.msg };
    const cfg = await getConfig();
    const banksById = await allBanksById();
    const fresh = await loanWithBorrower(rowIndex);
    return { success: true, detail: await loanPayload(fresh, banksById, Number(cfg.PENALTY_RATE) || 0, { admin: true }) };
  } catch (e) { return { success: false, msg: e.message }; }
}

async function addNewBorrower(d) {
  try {
    const email = norm(d.email);
    const { data: existing } = await db().from("borrowers").select("id").eq("email", email).maybeSingle();
    if (existing) return { success: false, msg: "That email already has a loan on file. Use \u201CAdd loan\u201D instead." };
    const { data: existingUser } = await db().from("users").select("id").eq("email", email).maybeSingle();
    if (existingUser) return { success: false, msg: "That email is already registered." };

    const { data: borrower, error: bErr } = await db().from("borrowers").insert({
      name: d.name, email: email, contact: d.contact || "", address: d.address || "",
      valid_id: d.idNum || "", cc_email: d.ccEmail || "",
    }).select().single();
    if (bErr) return { success: false, msg: bErr.message };

    const { bankId, dueDay } = await resolveBank(d.partner || d.bank);
    const { data: loan, error: lErr } = await db().from("loans").insert({
      borrower_id: borrower.id, ...loanFieldsFromForm(d, bankId, dueDay),
    }).select().single();
    if (lErr) return { success: false, msg: lErr.message };
    const lf = await saveLateFee(loan.id, d, null);   // before the welcome email, so its agreement shows the fee
    const bc = await saveBankCost(loan.id, d, null);

    // A random 4-digit PIN for every borrower (the form no longer offers a password, and nothing is hard-coded).
    const pin = randomPin();
    await db().from("users").insert({ email: email, password_hash: hashPassword(pin), role: "BORROWER" });

    try { await sendWelcomeEmailWithPin(loan.id, pin); } catch (e) { /* loan is saved either way */ }
    return { success: true, msg: "Borrower saved. Welcome email sent." + (lf.ok ? "" : " " + lf.msg) + (bc.ok ? "" : " " + bc.msg), rowIndex: loan.id, pin };
  } catch (e) { return { success: false, msg: e.message }; }
}

async function addLoanToExistingBorrower(d) {
  try {
    const { data: borrower } = await db().from("borrowers").select("id").eq("email", norm(d.email)).maybeSingle();
    if (!borrower) return { success: false, msg: "Borrower not found." };
    const { data: dupe } = await db().from("loans").select("id").eq("borrower_id", borrower.id).eq("loan_name", d.loanName || d.loanType).maybeSingle();
    if (dupe) return { success: false, msg: `This borrower already has a loan named \u201C${d.loanName || d.loanType}\u201D. Give the new one a different name.` };

    const { bankId, dueDay } = await resolveBank(d.partner || d.bank);
    const { data: loan, error } = await db().from("loans").insert({
      borrower_id: borrower.id, ...loanFieldsFromForm(d, bankId, dueDay),
    }).select().single();
    if (error) return { success: false, msg: error.message };
    const lf = await saveLateFee(loan.id, d, null);   // before the notice, so the agreement it attaches shows the fee
    const bc = await saveBankCost(loan.id, d, null);

    try { await sendNewLoanNotification(loan.id); } catch (e) { /* loan is saved either way */ }
    return { success: true, msg: "Loan added. Agreement emailed to the borrower." + (lf.ok ? "" : " " + lf.msg) + (bc.ok ? "" : " " + bc.msg), rowIndex: loan.id };
  } catch (e) { return { success: false, msg: e.message }; }
}

async function updateBorrower(rowIndex, d) {
  try {
    const loanRow = await loanWithBorrower(rowIndex);
    if (!loanRow) return { success: false, msg: "Loan not found." };
    const { bankId, dueDay } = await resolveBank(d.partner || d.bank);

    const oldEmail = norm(loanRow.borrowers.email), newEmail = norm(d.email);
    if (newEmail && newEmail !== oldEmail) {
      const { data: clash } = await db().from("borrowers").select("id").eq("email", newEmail).maybeSingle();
      if (clash) return { success: false, msg: "Another borrower already uses that email." };
    }
    const { error: bErr } = await db().from("borrowers").update({
      name: d.name, email: newEmail || oldEmail, contact: d.contact || "", address: d.address || "",
      valid_id: d.idNum || "", cc_email: d.ccEmail || "",
    }).eq("id", loanRow.borrower_id);
    if (bErr) return { success: false, msg: bErr.message };
    // the portal login is keyed by email, so it has to move with it
    if (newEmail && newEmail !== oldEmail) await db().from("users").update({ email: newEmail }).eq("email", oldEmail);

    const { error: lErr } = await db().from("loans").update(loanFieldsFromForm(d, bankId, dueDay)).eq("id", rowIndex);
    if (lErr) return { success: false, msg: lErr.message };
    const lf = await saveLateFee(rowIndex, d, loanRow);
    if (!lf.ok) return { success: false, msg: lf.msg };
    const bc = await saveBankCost(rowIndex, d, loanRow);
    if (!bc.ok) return { success: false, msg: bc.msg };
    return { success: true };
  } catch (e) { return { success: false, msg: e.message }; }
}

async function deleteBorrower(rowIndex /*, email, loanName — kept for signature parity, unused: id is authoritative */) {
  try {
    const loanRow = await loanWithBorrower(rowIndex);
    if (!loanRow) return { success: false, msg: "Loan not found." };
    const { error } = await db().from("loans").delete().eq("id", rowIndex);   // payments cascade
    if (error) return { success: false, msg: error.message };

    const { count } = await db().from("loans").select("id", { count: "exact", head: true }).eq("borrower_id", loanRow.borrower_id);
    if (!count) {
      const { data: borrower } = await db().from("borrowers").select("email").eq("id", loanRow.borrower_id).maybeSingle();
      await db().from("borrowers").delete().eq("id", loanRow.borrower_id);
      if (borrower) await db().from("users").delete().eq("email", norm(borrower.email));
    }
    return { success: true };
  } catch (e) { return { success: false, msg: e.message }; }
}

/* ---------------- payments ---------------- */

async function recordPayment(rowIndex, paymentMonth, paymentAmount, paymentDate, receiptNo, paymentMethod) {
  try {
    const cfg = await getConfig();
    const loanRow = await loanWithBorrower(rowIndex);
    if (!loanRow) return { success: false, msg: "Loan not found." };

    const receipt = (receiptNo && receiptNo.trim()) || `RC-${Date.now()}`;
    let paidDate = null;
    const parts = String(paymentDate || "").split("/");
    if (parts.length === 3) {
      const c = new Date(Number(parts[2]), Number(parts[0]) - 1, Number(parts[1]));
      if (!isNaN(c.getTime())) paidDate = c;
    }
    if (!paidDate) paidDate = new Date();

    const { error } = await db().from("payments").insert({
      loan_id: rowIndex, for_month: paymentMonth, amount: Number(paymentAmount),
      paid_date: fmtDate(paidDate, "yyyy-MM-dd"), receipt_no: receipt, method: paymentMethod || "Cash",
    });
    if (error) return { success: false, msg: error.message };

    const banksById = await allBanksById();
    const penaltyRate = Number(cfg.PENALTY_RATE) || 0;
    const engineLoan = toEngineLoan(loanRow, banksById);
    const payments = await paymentsForLoan(rowIndex);
    const fig = liveLoanFigures(engineLoan, payments, penaltyRate);

    // The receipt is sent from here, on the server, deliberately: if this were
    // handed back to the client as a follow-up call, closing the tab in that
    // gap would leave the payment recorded with no receipt ever sent, silently.
    let receiptSent = true, mailMsg = "";
    try {
      const { sendMail } = require("./mailer");
      const templates = require("./email-templates");
      const mail = templates.receiptEmail(cfg, {
        name: loanRow.borrowers.name, loanName: loanRow.loan_name, amount: Number(paymentAmount),
        month: paymentMonth, dateStr: fmtDate(paidDate, "MM/dd/yyyy"), method: paymentMethod || "Cash",
        receiptNo: receipt, balance: fig.balance, paid: fig.paid,
        pct: fig.paid + fig.balance > 0 ? Math.round((fig.paid / (fig.paid + fig.balance)) * 100) : 100,
        next: fig.next, remaining: fig.remaining, applied: appliedFor(fig, receipt, paymentAmount),
      });
      const res = await sendMail({
        to: loanRow.borrowers.email, cc: loanRow.borrowers.cc_email || undefined,
        subject: mail.subject, html: mail.html, fromName: cfg.COMPANY_NAME,
      });
      if (!res.success) { receiptSent = false; mailMsg = res.msg; }
      await logEmail({ loanId: rowIndex, borrowerName: loanRow.borrowers.name, to: loanRow.borrowers.email, cc: loanRow.borrowers.cc_email, type: "receipt", subject: mail.subject, result: res, html: mail.html });
    } catch (mailErr) { receiptSent = false; mailMsg = mailErr.message; }

    return {
      success: true, receiptNo: receipt, receiptSent, mailMsg,
      msg: `Payment recorded for ${loanRow.borrowers.name}.`,
      status: fig.statusText, balance: fig.balance, totalPaid: fig.paid, remaining: fig.remaining,
      detail: await loanPayload(loanRow, banksById, penaltyRate, { admin: true }),
    };
  } catch (e) { return { success: false, msg: e.message }; }
}

/** Re-sends the receipt for a payment already on record — never records again. */
/** How one payment was split between penalties/late fees and the loan itself (for its receipt). */
function appliedFor(fig, receiptNo, amount) {
  const list = (fig.money && fig.money.applied) || [];
  const a = list.find((x) => receiptNo && x.receiptNo === receiptNo) || list.find((x) => Math.abs(x.amount - Number(amount)) < 0.005 && x.toCharges > 0);
  return a && a.toCharges > 0 ? { toCharges: a.toCharges, toInstalments: a.toInstalments + (a.extra || 0) } : null;
}

async function sendPaymentReceipt(rowIndex, paymentMonth, paymentAmount, paymentDate, receiptNo, paymentMethod) {
  try {
    const { sendMail } = require("./mailer");
    const templates = require("./email-templates");
    const cfg = await getConfig();
    const loanRow = await loanWithBorrower(rowIndex);
    if (!loanRow) return { success: false, msg: "Loan not found." };
    const banksById = await allBanksById();
    const payments = await paymentsForLoan(rowIndex);
    const fig = liveLoanFigures(toEngineLoan(loanRow, banksById), payments, Number(cfg.PENALTY_RATE) || 0);
    const mail = templates.receiptEmail(cfg, {
      name: loanRow.borrowers.name, loanName: loanRow.loan_name, amount: Number(paymentAmount),
      month: paymentMonth, dateStr: paymentDate, method: paymentMethod || "Cash", receiptNo,
      balance: fig.balance, paid: fig.paid, pct: 100, next: fig.next, remaining: fig.remaining, applied: appliedFor(fig, receiptNo, paymentAmount),
    });
    const res = await sendMail({ to: loanRow.borrowers.email, cc: loanRow.borrowers.cc_email || undefined, subject: mail.subject, html: mail.html, fromName: cfg.COMPANY_NAME });
    await logEmail({ loanId: rowIndex, borrowerName: loanRow.borrowers.name, to: loanRow.borrowers.email, cc: loanRow.borrowers.cc_email, type: "receipt", subject: mail.subject, result: res, html: mail.html });
    return res.success ? { success: true, msg: `Receipt sent to ${loanRow.borrowers.name}.` } : { success: false, msg: res.msg };
  } catch (e) { return { success: false, msg: e.message }; }
}

/* ---------------- billing schedule ---------------- */

const ROW_LABEL = {
  PAID: "\u2705 PAID", OVERDUE: "\u26A0\uFE0F OVERDUE", PARTIAL: "\uD83D\uDCC9 PARTIAL",
  PENDING: "\u23F3 PENDING", FOR_PAYMENT: "\uD83D\uDCB3 FOR PAYMENT", PAST_TERM: "\uD83D\uDC80 PAST TERM",
};
function rowLabel(code) { return ROW_LABEL[code] || code; }

async function getBillingSchedule(rowIndex) {
  try {
    const cfg = await getConfig();
    const loanRow = await loanWithBorrower(rowIndex);
    if (!loanRow) return { success: false, msg: "Loan not found." };
    const banksById = await allBanksById();
    const payments = await paymentsForLoan(rowIndex);
    const built = buildSchedule(toEngineLoan(loanRow, banksById), payments, Number(cfg.PENALTY_RATE) || 0);
    const schedule = built.schedule.map((r) => ({ ...r, status: rowLabel(r.status) }));
    return {
      success: true, borrowerName: loanRow.borrowers.name, email: loanRow.borrowers.email, loanName: loanRow.loan_name,
      totalPayable: Number(loanRow.total_payable), monthlyAmort: Number(loanRow.monthly_amort), monthlyAmort2: Number(loanRow.monthly_amort),
      terms: Number(loanRow.terms), schedule, arrears: owedToday(built.schedule), termsMismatch: built.termsMismatch, expectedPayable: built.expectedPayable, impliedAmort: built.impliedAmort,
    };
  } catch (e) { return { success: false, msg: e.message }; }
}
async function getBillingScheduleByEmail(email, loanName) {
  const { data: borrower } = await db().from("borrowers").select("id").eq("email", norm(email)).maybeSingle();
  if (!borrower) return { success: false, msg: "Loan not found." };
  const { data: loan } = await db().from("loans").select("id").eq("borrower_id", borrower.id).eq("loan_name", loanName).maybeSingle();
  if (!loan) return { success: false, msg: "Loan not found." };
  return getBillingSchedule(loan.id);
}

/* ---------------- documents (SOA / Agreement) ---------------- */

async function getDocumentHtml(rowIndex, type) {
  try {
    const { buildSoaHtml, buildAgreementHtml } = require("./documents");
    const cfg = await getConfig();
    const loanRow = await loanWithBorrower(rowIndex);
    if (!loanRow) return { success: false, msg: "Loan not found." };
    const banksById = await allBanksById();
    const payments = await paymentsForLoan(rowIndex);
    const built = buildSchedule(toEngineLoan(loanRow, banksById), payments, Number(cfg.PENALTY_RATE) || 0);
    const bank = loanRow.bank_id ? banksById.get(loanRow.bank_id) : null;

    if (type === "agreement") {
      return { success: true, filename: `Loan Agreement - ${loanRow.borrowers.name}.pdf`, html: buildAgreementHtml(cfg, loanRow, bank) };
    }
    return { success: true, filename: `SOA - ${loanRow.borrowers.name}.pdf`, html: buildSoaHtml(cfg, loanRow, bank, payments, built.schedule) };
  } catch (e) { return { success: false, msg: e.message }; }
}

/* ---------------- reports ---------------- */

async function getAdvancedReport() {
  try {
    const cfg = await getConfig();
    const penaltyRate = Number(cfg.PENALTY_RATE) || 0;
    const banksById = await allBanksById();
    const { data: loans } = await db().from("loans").select("*, borrowers(*)");
    const ids = (loans || []).map((l) => l.id);
    const paymentsMap = await paymentsForLoans(ids);
    const now = today(), thisMonth = now.getMonth(), thisYear = now.getFullYear();
    const shortM = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    const perLoan = [];
    let totalReceivable = 0, target = 0, activeCount = 0;
    const trend = {}; const order = [];
    for (let t = 5; t >= 0; t--) {
      const mo = new Date(thisYear, thisMonth - t, 1);
      const k = `${mo.getFullYear()}-${mo.getMonth()}`;
      trend[k] = { label: `${shortM[mo.getMonth()]} ${String(mo.getFullYear()).slice(2)}`, amount: 0 };
      order.push(k);
    }
    let settled = 0, lastMonthSettled = 0, lastSettledToDate = 0, cashIn = 0;
    const lastKey = new Date(thisYear, thisMonth - 1, 1);
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(thisYear, thisMonth + 1, 0).getDate();
    const byBank = {};
    const future = {};   // real upcoming bills per calendar month, from each loan's own ledger
    const aging = { days30: [], days60: [], days90: [] };
    let agingTotal = 0;
    const topPayers = [];
    const delinquents = [];
    // Income monitor: what was actually earned and collected, apart from the money that repays the loan.
    const income = { principal: 0, interest: 0, fee: 0, penaltiesCharged: 0, penaltiesPaid: 0, lateFeesCharged: 0, lateFeesPaid: 0, chargesOwed: 0 };
    const incomeLoans = [];
    const profit = { markup: 0, interestIncome: 0, feeIncome: 0, bankInterest: 0, bankFees: 0, loans: 0, missing: 0, expected: 0, extras: 0, bankTotal: 0, bankPaid: 0, collected: 0, netCash: 0, projectedNet: 0 };
    const profitLoans = [];
    const incomeByMonth = {};
    for (let t = 5; t >= 0; t--) {
      const mo = new Date(thisYear, thisMonth - t, 1);
      incomeByMonth[`${mo.getFullYear()}-${mo.getMonth()}`] = { label: `${shortM[mo.getMonth()]} ${String(mo.getFullYear()).slice(2)}`, interest: 0, charges: 0 };
    }

    for (const l of loans || []) {
      const engineLoan = toEngineLoan(l, banksById);
      const payments = paymentsMap.get(l.id) || [];
      const fig = liveLoanFigures(engineLoan, payments, penaltyRate);
      const bank = l.bank_id ? banksById.get(l.bank_id) : null;
      const closed = fig.status === "FULLY_PAID";
      totalReceivable += fig.balance;
      if (!closed) {
        target += Number(l.monthly_amort) || 0; activeCount++;
        for (const r of fig.built.schedule) {
          if (r.isPast || r.outstanding <= 0) continue;
          const k = `${r.dueDateObj.getFullYear()}-${r.dueDateObj.getMonth()}`;
          future[k] = future[k] || { amount: 0, loans: 0 };
          future[k].amount += r.outstanding; future[k].loans++;
        }
      }

      const bankName = bank?.name || "Unassigned";
      byBank[bankName] = byBank[bankName] || { bank: bankName, borrowers: 0, totalBalance: 0, totalAmort: 0, overdue: 0 };
      byBank[bankName].borrowers++;
      byBank[bankName].totalBalance += fig.balance;
      if (!closed) byBank[bankName].totalAmort += Number(l.monthly_amort) || 0;
      if (fig.arrears > 0) byBank[bankName].overdue++;

      const totalPaidForLoan = round2(payments.reduce((a, p) => a + p.amount, 0));
      if (totalPaidForLoan > 0) topPayers.push({ name: l.borrowers.name, totalPaid: totalPaidForLoan, payCount: payments.length });

      for (const p of payments) {
        if (!p.date) continue;
        const pd = day0(p.date);
        const tk = `${pd.getFullYear()}-${pd.getMonth()}`;
        if (trend[tk]) trend[tk].amount += p.amount;
        if (pd.getMonth() === thisMonth && pd.getFullYear() === thisYear) cashIn += p.amount;
        const mk = monthKeyFrom(p.month);
        if (mk) {
          if (mk.year === thisYear && mk.month === thisMonth) settled += p.amount;
          if (mk.year === lastKey.getFullYear() && mk.month === lastKey.getMonth()) {
            lastMonthSettled += p.amount;
            if (pd.getDate() <= dayOfMonth) lastSettledToDate += p.amount;
          }
        }
      }

      if (fig.arrears > 0) {
        const oldest = fig.built.schedule.find((r) => r.isPast && r.outstanding > 0);
        const daysLate = oldest ? Math.max(0, Math.ceil((now - day0(oldest.dueDateObj)) / 86400000)) : 0;
        const entry = { name: l.borrowers.name, loan: l.loan_name, overdue: round2(fig.arrears), balance: fig.balance, contact: l.borrowers.contact || "", daysOverdue: daysLate };
        if (daysLate <= 30) aging.days30.push(entry); else if (daysLate <= 60) aging.days60.push(entry); else aging.days90.push(entry);
        agingTotal += fig.arrears;
        delinquents.push({ name: l.borrowers.name, email: l.borrowers.email, loan: l.loan_name, overdue: round2(fig.arrears), balance: fig.balance, contact: l.borrowers.contact || "", nextDue: fig.next ? fig.next.dueDate : "", status: fig.statusText, daysLate });
      }
      const mn = fig.money;
      income.principal += mn.principalPaid; income.interest += mn.interestPaid; income.fee += mn.feePaid;
      income.penaltiesCharged += mn.penaltiesCharged; income.penaltiesPaid += mn.penaltiesPaid;
      income.lateFeesCharged += mn.lateFeesCharged; income.lateFeesPaid += mn.lateFeesPaid; income.chargesOwed += mn.chargesOwed;
      for (const a of mn.applied) {
        if (!a.date) continue;
        const slot = incomeByMonth[`${a.date.getFullYear()}-${a.date.getMonth()}`];
        if (slot) { slot.charges += a.toCharges; slot.interest += a.toInstalments * mn.interestRatio; }
      }
      const pf = fig.profit;
      if (pf.hasBankCost) {
        profit.loans++; profit.markup += pf.interestMarkup; profit.interestIncome += pf.interestIncome; profit.feeIncome += pf.feeIncome; profit.bankInterest += pf.bankInterest; profit.bankFees += pf.bankFeeCharged; profit.expected += pf.expectedProfit; profit.extras += pf.extrasCollected; profit.bankTotal += pf.bankTotal;
        profit.bankPaid += pf.bankPaid; profit.collected += pf.collected; profit.netCash += pf.netCash; profit.projectedNet += pf.projectedNet;
        profitLoans.push({ name: l.borrowers.name, loan: l.loan_name, borrowerTotal: pf.borrowerTotal, bankTotal: pf.bankTotal, expectedProfit: pf.expectedProfit,
          extrasCollected: pf.extrasCollected, netCash: pf.netCash, projectedNet: pf.projectedNet });
      } else if (fig.status !== "FULLY_PAID") profit.missing++;
      if (mn.interestPaid > 0 || mn.penaltiesCharged > 0 || mn.lateFeesCharged > 0) {
        incomeLoans.push({ name: l.borrowers.name, loan: l.loan_name, interestPaid: mn.interestPaid,
          penaltiesPaid: mn.penaltiesPaid, penaltiesCharged: mn.penaltiesCharged,
          lateFeesPaid: mn.lateFeesPaid, lateFeesCharged: mn.lateFeesCharged, chargesOwed: mn.chargesOwed });
      }
      perLoan.push({ name: l.borrowers.name, loan: l.loan_name, balance: fig.balance, amountPaid: fig.paid, status: fig.statusText, contact: l.borrowers.contact || "", nextDue: fig.next ? fig.next.dueDate : "" });
    }

    topPayers.sort((a, b) => b.totalPaid - a.totalPaid);
    delinquents.sort((a, b) => b.daysLate - a.daysLate);
    const bankBreakdown = Object.values(byBank).sort((a, b) => b.totalBalance - a.totalBalance);
    const projected = [1, 2, 3].map((m) => {
      const d = new Date(thisYear, thisMonth + m, 1);
      const slot = future[`${d.getFullYear()}-${d.getMonth()}`] || { amount: 0, loans: 0 };
      return { label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, expected: round2(slot.amount), borrowers: slot.loans };
    });

    return {
      success: true,
      collectionRate: {
        month: `${MONTHS[thisMonth]} ${thisYear}`, collected: round2(settled), target: round2(target),
        rate: target > 0 ? Math.round((settled / target) * 100) : 0, cashIn: round2(cashIn),
        lastMonth: round2(lastMonthSettled), lastMonthToDate: round2(lastSettledToDate),
        dayOfMonth, daysInMonth, monthInProgress: dayOfMonth < daysInMonth,
        pace: lastSettledToDate > 0 ? Math.round(((settled - lastSettledToDate) / lastSettledToDate) * 100) : null,
        growth: lastMonthSettled > 0 ? Math.round(((settled - lastMonthSettled) / lastMonthSettled) * 100) : 0,
      },
      totalReceivable: round2(totalReceivable),
      trend: order.map((k) => trend[k]),
      aging, agingTotal: round2(agingTotal), bankBreakdown, projected,
      topPayers: topPayers.slice(0, 10), delinquents, allBorrowers: perLoan,
      profit: {
        loans: profit.loans, missing: profit.missing, expected: round2(profit.expected),
        markup: round2(profit.markup), interestIncome: round2(profit.interestIncome), feeIncome: round2(profit.feeIncome), bankInterest: round2(profit.bankInterest), bankFees: round2(profit.bankFees), extras: round2(profit.extras),
        bankTotal: round2(profit.bankTotal), bankPaid: round2(profit.bankPaid), collected: round2(profit.collected),
        netCash: round2(profit.netCash), projectedNet: round2(profit.projectedNet),
        list: profitLoans.sort((a, b) => b.projectedNet - a.projectedNet),
      },
      income: {
        interest: round2(income.interest), fee: round2(income.fee), principal: round2(income.principal),
        penaltiesCharged: round2(income.penaltiesCharged), penaltiesPaid: round2(income.penaltiesPaid),
        lateFeesCharged: round2(income.lateFeesCharged), lateFeesPaid: round2(income.lateFeesPaid),
        chargesPaid: round2(income.penaltiesPaid + income.lateFeesPaid), chargesOwed: round2(income.chargesOwed),
        byMonth: order.map((k) => ({ label: incomeByMonth[k].label, interest: round2(incomeByMonth[k].interest), charges: round2(incomeByMonth[k].charges) })),
        loans: incomeLoans.sort((a, b) => (b.penaltiesPaid + b.lateFeesPaid + b.chargesOwed) - (a.penaltiesPaid + a.lateFeesPaid + a.chargesOwed)),
      },
    };
  } catch (e) { return { success: false, msg: e.message }; }
}

async function getCollectionHistory() {
  try {
    const { data: payments } = await db().from("payments").select("*, loans(loan_name, borrowers(name))").order("paid_date");
    const received = {}, billing = {}, methods = {}, years = {};
    let lifetime = 0, count = 0, first = null, last = null, unlabelled = 0, undated = 0;

    for (const p of payments || []) {
      const amount = Number(p.amount) || 0;
      if (!amount) continue;
      const when = p.paid_date ? new Date(p.paid_date) : null;
      lifetime += amount; count++;
      if (when) { if (!first || when < first) first = when; if (!last || when > last) last = when; }
      else undated++;

      const name = p.loans?.borrowers?.name || "\u2014", loanName = p.loans?.loan_name || "\u2014";
      const mk = monthKeyFrom(p.for_month);
      const payment = { name, email: "", loan: loanName, forMonth: p.for_month || "\u2014", amount,
        date: when ? fmtDate(when, "MM/dd/yyyy") : "", sortDate: when ? when.getTime() : 0,
        receiptNo: p.receipt_no || "", method: p.method || "Unrecorded" };

      function bucket(map, key, year, monthIndex, label) {
        if (!map[key]) map[key] = { key, year, monthIndex, label, total: 0, count: 0, payments: [] };
        map[key].total += amount; map[key].count++; map[key].payments.push(payment);
      }
      if (when) { bucket(received, `${when.getFullYear()}-${when.getMonth()}`, when.getFullYear(), when.getMonth(), `${MONTHS[when.getMonth()]} ${when.getFullYear()}`); years[when.getFullYear()] = (years[when.getFullYear()] || 0) + amount; }
      else bucket(received, "undated", 0, 0, "Date not recorded");

      if (mk) bucket(billing, mk.key, mk.year, mk.month, mk.label); else { unlabelled++; bucket(billing, "unknown", 0, 0, "No billing month recorded"); }

      const method = p.method || "Unrecorded";
      methods[method] = methods[method] || { method, total: 0, count: 0 };
      methods[method].total += amount; methods[method].count++;
    }
    function finish(map) {
      return Object.values(map).map((m) => { m.total = round2(m.total); m.payments.sort((a, b) => b.sortDate - a.sortDate); return m; })
        .sort((a, b) => (a.key < b.key ? 1 : -1));
    }
    const monthsOfHistory = first && last ? monthsBetween(last, first) + 1 : 1;
    const receivedList = finish(received);
    const best = receivedList.slice().sort((a, b) => b.total - a.total)[0] || null;

    return {
      success: true, lifetime: round2(lifetime), count, unlabelled, undated,
      firstPayment: first ? fmtDate(first, "MMMM dd, yyyy") : "", lastPayment: last ? fmtDate(last, "MMMM dd, yyyy") : "",
      monthlyAverage: round2(lifetime / Math.max(1, monthsOfHistory)), activeMonths: Math.max(1, monthsOfHistory),
      bestMonth: best ? { label: best.label, total: best.total } : null,
      years: Object.keys(years).map((y) => ({ year: Number(y), total: round2(years[y]) })).sort((a, b) => b.year - a.year),
      received: receivedList, billing: finish(billing),
      methods: Object.values(methods).map((m) => ({ ...m, total: round2(m.total) })).sort((a, b) => b.total - a.total),
    };
  } catch (e) { return { success: false, msg: e.message }; }
}

/* ---------------- credit scores ---------------- */

async function getCreditScores() {
  try {
    const cfg = await getConfig();
    const penaltyRate = Number(cfg.PENALTY_RATE) || 0;
    const banksById = await allBanksById();
    const { data: borrowers } = await db().from("borrowers").select("*, loans(*)");
    const list = [];
    for (const b of borrowers || []) {
      const loans = (b.loans || []).map((l) => toEngineLoan(l, banksById));
      const paymentsByLoanId = new Map();
      for (const l of b.loans || []) paymentsByLoanId.set(l.id, await paymentsForLoan(l.id));
      const res = scoreBorrower(loans, paymentsByLoanId, penaltyRate);
      list.push({
        name: b.name, email: b.email, contact: b.contact || "", loans: (b.loans || []).length,
        scored: res.scored, thin: !!res.thin, stale: !!res.stale, monthsSinceLast: res.monthsSinceLast || 0,
        score: res.score || 0, grade: res.scored && !res.thin ? res.grade : "\u2014",
        label: !res.scored ? "No billed cycles yet" : (res.thin ? "Building history" : res.label),
        tone: res.scored && !res.thin ? res.tone : "",
        cycles: res.cycles || 0, arrears: round2(res.arrears || 0), avgDaysLate: res.avgDaysLate || 0,
        closedLoans: res.closedLoans || 0, trend: res.trend ? res.trend.direction : null, trendDelta: res.trend ? res.trend.delta : 0,
      });
    }
    const scored = list.filter((x) => x.scored && !x.thin);
    const average = scored.length ? Math.round(scored.reduce((a, x) => a + x.score, 0) / scored.length) : 0;
    const buckets = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    scored.forEach((x) => { if (buckets[x.grade] != null) buckets[x.grade]++; });
    list.sort((a, b) => (a.scored !== b.scored ? (a.scored ? -1 : 1) : b.score - a.score));
    return { success: true, borrowers: list, average, scoredCount: scored.length, buckets };
  } catch (e) { return { success: false, msg: e.message }; }
}

async function loansAndPaymentsForEmail(email) {
  const { data: borrower } = await db().from("borrowers").select("*, loans(*)").eq("email", norm(email)).maybeSingle();
  if (!borrower) return null;
  const banksById = await allBanksById();
  const loans = (borrower.loans || []).map((l) => toEngineLoan(l, banksById));
  const paymentsByLoanId = new Map();
  for (const l of borrower.loans || []) paymentsByLoanId.set(l.id, await paymentsForLoan(l.id));
  return { borrower, loans, paymentsByLoanId };
}

async function getCreditScore(email) {
  try {
    if (!email) return { success: false, msg: "No email provided." };
    const cfg = await getConfig();
    const found = await loansAndPaymentsForEmail(email);
    if (!found) return { success: false, msg: "Borrower not found." };
    const res = scoreBorrower(found.loans, found.paymentsByLoanId, Number(cfg.PENALTY_RATE) || 0);
    return { success: true, name: found.borrower.name, email, loans: found.loans.length, ...res };
  } catch (e) { return { success: false, msg: e.message }; }
}

async function getLendingGuide(email) {
  try {
    if (!email) return { success: false, msg: "No email provided." };
    const cfg = await getConfig();
    const found = await loansAndPaymentsForEmail(email);
    if (!found) return { success: false, msg: "Borrower not found." };
    const g = lendingGuide(found.loans, found.paymentsByLoanId, Number(cfg.PENALTY_RATE) || 0);
    return { success: true, name: found.borrower.name, email, ...g };
  } catch (e) { return { success: false, msg: e.message }; }
}

const EMAIL_LOG_COLS = "id,loan_id,borrower_name,to_email,cc_email,email_type,subject,status,error_message,resend_id,created_at";
function emailLogEntry(r) {
  return {
    id: r.id, loanId: r.loan_id, borrowerName: r.borrower_name, to: r.to_email, cc: r.cc_email,
    type: r.email_type, subject: r.subject, status: r.status, error: r.error_message,
    resendId: r.resend_id, attachments: r.attachment_names || "",
    date: fmtDate(new Date(r.created_at), "MM/dd/yyyy"),
    time: new Date(r.created_at).toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Manila" }),
  };
}

/** The app's own record of every email sent, newest first -- reviewable without opening Resend.
 *  The (large) body is left out of the list; getEmailLogEntry() fetches it on demand. */
async function getEmailLog(limit) {
  try {
    const n = Number(limit) || 100;
    let res = await db().from("email_log").select(EMAIL_LOG_COLS + ",attachment_names").order("created_at", { ascending: false }).limit(n);
    if (res.error) res = await db().from("email_log").select(EMAIL_LOG_COLS).order("created_at", { ascending: false }).limit(n);
    if (res.error) throw new Error(res.error.message);
    return { success: true, entries: (res.data || []).map(emailLogEntry) };
  } catch (e) { return { success: false, msg: e.message }; }
}

/** One log row including the saved email body (null for emails sent before bodies were kept). */
async function getEmailLogEntry(id) {
  try {
    const { data, error } = await db().from("email_log").select("*").eq("id", Number(id)).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return { success: false, msg: "Log entry not found." };
    return {
      success: true, entry: { ...emailLogEntry(data), html: data.body_html || "", bodyStored: !!data.body_html,
        bodySkipped: data.email_type === "reset_pin" },
    };
  } catch (e) { return { success: false, msg: e.message }; }
}

/* ---------------- maintenance: loan data health ---------------- */

async function auditLoanTerms() {
  const { data: loans } = await db().from("loans").select("*, borrowers(name)");
  const found = [];
  for (const l of loans || []) {
    const payable = Number(l.total_payable) || 0, terms = Number(l.terms) || 0, fee = Number(l.processing_fee) || 0, amort = Number(l.monthly_amort) || 0;
    if (!payable || !terms) continue;
    const gap = round2(payable - (amort * terms + fee));
    if (Math.abs(gap) <= round2(terms * 1)) continue;
    const implied = round2((payable - fee) / terms);
    found.push({ row: l.id, name: l.borrowers.name, loan: l.loan_name, terms, payable, fee, stored: amort, implied });
  }
  const report = found.length ? `${found.length} loan(s) with an amortization that does not add up.` : "Every loan's amortization agrees with its terms and total payable.";
  return { success: true, count: found.length, loans: found, report };
}
async function fixLoanAmortizations() {
  const audit = await auditLoanTerms();
  if (!audit.count) return { success: true, fixed: 0, report: "Nothing to fix." };
  for (const L of audit.loans) await db().from("loans").update({ monthly_amort: L.implied }).eq("id", L.row);
  return { success: true, fixed: audit.loans.length, report: `Corrected ${audit.loans.length} loan(s).` };
}

/* ---------------- emails ---------------- */

/** Re-sending the welcome note cannot show the PIN (only its hash is stored), so it points to the first email
 *  and to Forgot password instead of changing anyone's password. */
async function sendWelcomeEmail(rowIndex) { return sendWelcomeEmailWithPin(rowIndex, null); }
async function sendWelcomeEmailWithPin(rowIndex, pin) {
  try {
    const { sendMail } = require("./mailer");
    const templates = require("./email-templates");
    const { renderAgreementPdf } = require("./pdf-documents");
    const cfg = await getConfig();
    const loanRow = await loanWithBorrower(rowIndex);
    if (!loanRow) return "\u274C Loan not found.";
    const html = templates.welcomeEmail(cfg, { name: loanRow.borrowers.name, email: loanRow.borrowers.email, loanName: loanRow.loan_name, pin });
    const banksById = await allBanksById();
    const bank = loanRow.bank_id ? banksById.get(loanRow.bank_id) : null;
    const pdf = await renderAgreementPdf(cfg, loanRow, bank);
    const attachments = [{ filename: `Loan Agreement - ${loanRow.borrowers.name}.pdf`, content: pdf, contentType: "application/pdf" }];
    const res = await sendMail({ to: loanRow.borrowers.email, cc: loanRow.borrowers.cc_email || undefined, subject: html.subject, html: html.html, fromName: cfg.COMPANY_NAME, attachments });
    await logEmail({ loanId: rowIndex, borrowerName: loanRow.borrowers.name, to: loanRow.borrowers.email, cc: loanRow.borrowers.cc_email, type: "welcome", subject: html.subject, result: res, html: (pin ? templates.welcomeEmail(cfg, { name: loanRow.borrowers.name, email: loanRow.borrowers.email, loanName: loanRow.loan_name, pin: "\u2022\u2022\u2022\u2022" }).html : html.html), attachments });
    return res.success ? `\u2705 Welcome email sent to ${loanRow.borrowers.name}` : `\u274C ${res.msg}`;
  } catch (e) { return `\u274C ${e.message}`; }
}

async function sendNewLoanNotification(rowIndex) {
  try {
    const { sendMail } = require("./mailer");
    const templates = require("./email-templates");
    const { renderAgreementPdf } = require("./pdf-documents");
    const cfg = await getConfig();
    const loanRow = await loanWithBorrower(rowIndex);
    if (!loanRow) return "\u274C Loan not found.";
    const banksById = await allBanksById();
    const payments = await paymentsForLoan(rowIndex);
    const built = buildSchedule(toEngineLoan(loanRow, banksById), payments, Number(cfg.PENALTY_RATE) || 0);
    const next = nextBillFrom(built);
    const html = templates.newLoanEmail(cfg, {
      name: loanRow.borrowers.name, loanName: loanRow.loan_name, principal: loanRow.principal,
      monthlyRate: `${Number(loanRow.monthly_rate).toFixed(2)}%`, fee: loanRow.processing_fee,
      totalInterest: loanRow.total_interest, totalPayable: loanRow.total_payable, terms: loanRow.terms,
      monthlyAmort: loanRow.monthly_amort, dueDateStr: next ? next.dueDate : fmtDate(built.firstDue, "MMMM dd, yyyy"),
      lateFee: Number(loanRow.late_fee) || 0,
    });
    const bank = loanRow.bank_id ? banksById.get(loanRow.bank_id) : null;
    const pdf = await renderAgreementPdf(cfg, loanRow, bank);
    const attachments = [{ filename: `Loan Agreement - ${loanRow.borrowers.name} - ${loanRow.loan_name}.pdf`, content: pdf, contentType: "application/pdf" }];
    const res = await sendMail({ to: loanRow.borrowers.email, cc: loanRow.borrowers.cc_email || undefined, subject: html.subject, html: html.html, fromName: cfg.COMPANY_NAME, attachments });
    await logEmail({ loanId: rowIndex, borrowerName: loanRow.borrowers.name, to: loanRow.borrowers.email, cc: loanRow.borrowers.cc_email, type: "new_loan", subject: html.subject, result: res, html: html.html, attachments });
    return res.success ? `\u2705 Loan notice sent to ${loanRow.borrowers.name}` : `\u274C ${res.msg}`;
  } catch (e) { return `\u274C ${e.message}`; }
}

async function sendMonthlyStatement(rowIndex) {
  try {
    const { sendMail } = require("./mailer");
    const templates = require("./email-templates");
    const { renderSoaPdf } = require("./pdf-documents");
    const cfg = await getConfig();
    const loanRow = await loanWithBorrower(rowIndex);
    if (!loanRow) return "\u274C Loan not found.";
    const banksById = await allBanksById();
    const payments = await paymentsForLoan(rowIndex);
    const built = buildSchedule(toEngineLoan(loanRow, banksById), payments, Number(cfg.PENALTY_RATE) || 0);
    const balance = balanceFrom(built.schedule);
    const paid = round2(built.schedule.reduce((a, r) => a + r.paid, 0));
    const next = nextBillFrom(built);
    const pct = paid + balance > 0 ? Math.min(100, Math.round((paid / (paid + balance)) * 100)) : 100;
    const monthLabel = fmtDate(new Date(), "MMMM yyyy");
    const html = templates.statementEmail(cfg, {
      name: loanRow.borrowers.name, loanName: loanRow.loan_name, monthLabel, next, pct, balance, paid,
      monthlyAmort: loanRow.monthly_amort, remaining: balance <= 0 ? 0 : remainingFrom(built.schedule),
      recentPayments: payments.map((p) => ({ month: p.month, amount: p.amount, date: p.date ? fmtDate(p.date, "MM/dd/yyyy") : "" })),
    });
    // The email text promises an attached statement — it must actually be there.
    const bank = loanRow.bank_id ? banksById.get(loanRow.bank_id) : null;
    const pdf = await renderSoaPdf(cfg, loanRow, bank, payments, built.schedule);
    const attachments = [{ filename: `SOA - ${loanRow.borrowers.name} - ${monthLabel}.pdf`, content: pdf, contentType: "application/pdf" }];
    const res = await sendMail({ to: loanRow.borrowers.email, cc: loanRow.borrowers.cc_email || undefined, subject: html.subject, html: html.html, fromName: cfg.COMPANY_NAME, attachments });
    await logEmail({ loanId: rowIndex, borrowerName: loanRow.borrowers.name, to: loanRow.borrowers.email, cc: loanRow.borrowers.cc_email, type: "statement", subject: html.subject, result: res, html: html.html, attachments });
    return res.success ? `\u2705 Statement sent to ${loanRow.borrowers.name}` : `\u274C ${res.msg}`;
  } catch (e) { return `\u274C ${e.message}`; }
}

async function sendDueDateReminder(rowIndex) {
  try {
    const { sendMail } = require("./mailer");
    const templates = require("./email-templates");
    const cfg = await getConfig();
    const loanRow = await loanWithBorrower(rowIndex);
    if (!loanRow) return "\u274C Loan not found.";
    const banksById = await allBanksById();
    const payments = await paymentsForLoan(rowIndex);
    const built = buildSchedule(toEngineLoan(loanRow, banksById), payments, Number(cfg.PENALTY_RATE) || 0);
    const balance = balanceFrom(built.schedule);
    // A settled ledger must never trigger a reminder quoting a stale amount —
    // the exact bug chased down with John A.'s "0.00 balance, 180.21 due"
    // receipt. Guard it here too, not just in nextBillFrom.
    if (balance <= 0) return `\u2705 ${loanRow.borrowers.name} has nothing due \u2014 reminder skipped.`;

    const next = nextBillFrom(built);
    // This cycle is already paid and only an overdue amount remains: that is billed with the
    // statement, so there is nothing new to remind about (and a "P0.00 due" email helps no one).
    if (next && next.bill <= 0 && next.overdueSeparate > 0) {
      return `\u2705 ${loanRow.borrowers.name}: this month is paid; the overdue is billed with the statement on ${next.mergesOn} \u2014 reminder skipped.`;
    }
    const amount = next ? next.bill : Number(loanRow.monthly_amort);
    const dueStr = next ? next.dueDate : fmtDate(built.firstDue, "MMMM dd, yyyy");
    const days = next ? Math.ceil((day0(new Date(next.dueDateObj)) - today()) / 86400000) : 0;
    const html = templates.reminderEmail(cfg, {
      name: loanRow.borrowers.name, loanName: loanRow.loan_name, amount, dueStr, days, balance,
      remaining: remainingFrom(built.schedule), hasCarry: !!next?.hasCarry, carryAmount: next?.carryAmount || 0,
      lateFee: Number(loanRow.late_fee) || 0, overdueSeparate: next?.overdueSeparate || 0, mergesOn: next?.mergesOn || "",
    });
    const res = await sendMail({ to: loanRow.borrowers.email, cc: loanRow.borrowers.cc_email || undefined, subject: html.subject, html: html.html, fromName: cfg.COMPANY_NAME });
    await logEmail({ loanId: rowIndex, borrowerName: loanRow.borrowers.name, to: loanRow.borrowers.email, cc: loanRow.borrowers.cc_email, type: "reminder", subject: html.subject, result: res, html: html.html });
    return res.success ? `\u2705 Reminder sent to ${loanRow.borrowers.name}` : `\u274C ${res.msg}`;
  } catch (e) { return `\u274C ${e.message}`; }
}

/* ---------------- announcements (to many borrowers at once) ---------------- */

/**
 * Who an announcement goes to, one entry per email address:
 *   active   - borrowers who still owe something (default)
 *   overdue  - only borrowers with an amount overdue right now (their overdue loans only)
 *   everyone - every borrower on file, including those fully paid up
 */
async function borrowerAudience(kind) {
  const byEmail = new Map();
  for (const { row, fig } of await allLoansLive()) {
    const include = kind === "everyone" ? true : kind === "overdue" ? fig.arrears > 0 : fig.balance > 0;
    if (!include) continue;
    const key = norm(row.borrowers.email);
    if (!key) continue;
    const e = byEmail.get(key) || { email: row.borrowers.email, cc: row.borrowers.cc_email || "", name: row.borrowers.name, loans: [], loanIds: [] };
    e.loans.push(row.loan_name); e.loanIds.push(row.id);
    byEmail.set(key, e);
  }
  return [...byEmail.values()];
}
const lateFeeAudience = () => borrowerAudience("active");
const AUDIENCE_KINDS = ["active", "overdue", "everyone"];

/**
 * Sends one email per recipient, logging each. Safe to run again: anyone who already received an
 * announcement with this exact subject is skipped (unless resendAll). Paces itself for Resend's
 * ~2 requests/second and stops before the serverless time limit, reporting how many are left.
 */
async function broadcast({ audience, build, resendAll }) {
  const { sendMail } = require("./mailer");
  const cfg = await getConfig();
  const subject = build(audience[0]).subject;
  const done = new Set();
  if (!resendAll) {
    const { data: already } = await db().from("email_log").select("to_email").eq("email_type", "announcement").eq("subject", subject).eq("status", "sent");
    for (const r of already || []) done.add(norm(r.to_email));
  }
  const delay = Number(process.env.NOTICE_SEND_DELAY_MS ?? 550);
  const started = Date.now();
  let sent = 0, skipped = 0, left = 0;
  const failures = [];
  for (const e of audience) {
    if (done.has(norm(e.email))) { skipped++; continue; }
    if (Date.now() - started > 45000) { left++; continue; }
    if (sent + failures.length > 0 && delay > 0) await new Promise((r) => setTimeout(r, delay));
    const mail = build(e);
    const res = await sendMail({ to: e.email, cc: e.cc || undefined, subject: mail.subject, html: mail.html, fromName: cfg.COMPANY_NAME });
    await logEmail({ loanId: e.loanIds[0], borrowerName: e.name, to: e.email, cc: e.cc, type: "announcement", subject: mail.subject, result: res, html: mail.html });
    if (res.success) sent++; else failures.push({ name: e.name, msg: res.msg });
  }
  return { total: audience.length, sent, skipped, failed: failures.length, remaining: left, failures };
}

/** One test email to a single address; logged, but never touches borrowers or loans. */
async function sendTestAnnouncement(to, mail) {
  const { sendMail } = require("./mailer");
  const cfg = await getConfig();
  const addr = String(to).trim();
  const res = await sendMail({ to: addr, subject: "[TEST] " + mail.subject, html: mail.html, fromName: cfg.COMPANY_NAME });
  await logEmail({ borrowerName: "TEST", to: addr, type: "announcement", subject: "[TEST] " + mail.subject, result: res, html: mail.html });
  return res.success ? { success: true, test: true, msg: `Test sent to ${addr}.` } : { success: false, msg: res.msg };
}

/* ----- general announcement: the admin writes the subject and message ----- */

function parseAnnouncement(d) {
  const subject = String((d && d.subject) || "").trim();
  const message = String((d && d.message) || "").trim();
  const kind = AUDIENCE_KINDS.includes(d && d.audience) ? d.audience : "active";
  if (!subject) return { error: "Write a subject." };
  if (subject.length > 150) return { error: "Keep the subject under 150 characters." };
  if (!message) return { error: "Write the message." };
  if (message.length > 5000) return { error: "Keep the message under 5,000 characters." };
  return { subject, message, kind, button: d.button !== false, resendAll: !!d.resendAll };
}
const SAMPLE_RECIPIENT = { name: "Juan Dela Cruz", loans: ["Credit-To-Cash (20K)"], loanIds: [] };

async function getAnnouncementAudience(kind) {
  try {
    const aud = await borrowerAudience(AUDIENCE_KINDS.includes(kind) ? kind : "active");
    return { success: true, borrowers: aud.length, loans: aud.reduce((a, e) => a + e.loans.length, 0) };
  } catch (e) { return { success: false, msg: e.message }; }
}

async function previewAnnouncement(d) {
  try {
    const p = parseAnnouncement(d);
    if (p.error) return { success: false, msg: p.error };
    const cfg = await getConfig();
    const sample = (await borrowerAudience(p.kind))[0] || SAMPLE_RECIPIENT;
    const mail = require("./email-templates").announcementEmail(cfg, { name: sample.name, loans: sample.loans, subject: p.subject, message: p.message, button: p.button });
    return { success: true, subject: mail.subject, html: mail.html };
  } catch (e) { return { success: false, msg: e.message }; }
}

async function sendAnnouncement(d) {
  try {
    const p = parseAnnouncement(d);
    if (p.error) return { success: false, msg: p.error };
    const cfg = await getConfig();
    const tpl = require("./email-templates");
    const build = (e) => tpl.announcementEmail(cfg, { name: e.name, loans: e.loans, subject: p.subject, message: p.message, button: p.button });
    if (d.testTo) return await sendTestAnnouncement(d.testTo, build((await borrowerAudience(p.kind))[0] || SAMPLE_RECIPIENT));
    const audience = await borrowerAudience(p.kind);
    if (!audience.length) return { success: false, msg: "Nobody matches that audience right now." };
    return { success: true, ...(await broadcast({ audience, build, resendAll: p.resendAll })) };
  } catch (e) { return { success: false, msg: e.message }; }
}

/* ----- late payment fee announcement ----- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function parseNoticeInput(d) {
  const amount = round2(d && d.amount);
  if (!(amount > 0)) return { error: "Enter the late payment fee amount (more than 0)." };
  const iso = String((d && d.effectiveDate) || "");
  if (!ISO_DATE.test(iso) || isNaN(new Date(iso).getTime())) return { error: "Choose the date the late fee starts." };
  if (iso < fmtDate(today(), "yyyy-MM-dd")) return { error: "The start date cannot be in the past." };
  return { amount, iso, effectiveStr: fmtDate(new Date(iso + "T00:00:00"), "MMMM dd, yyyy") };
}

async function getLateFeeNoticeInfo() {
  try {
    const cfg = await getConfig();
    const aud = await lateFeeAudience();
    return { success: true, borrowers: aud.length, loans: aud.reduce((a, e) => a + e.loans.length, 0), defaultAmount: Number(cfg.LATE_FEE_DEFAULT) || 0 };
  } catch (e) { return { success: false, msg: e.message }; }
}

async function previewLateFeeNotice(d) {
  try {
    const p = parseNoticeInput(d);
    if (p.error) return { success: false, msg: p.error };
    const cfg = await getConfig();
    const sample = (await lateFeeAudience())[0] || SAMPLE_RECIPIENT;
    const mail = require("./email-templates").lateFeeNoticeEmail(cfg, { name: sample.name, loans: sample.loans, amount: p.amount, effectiveStr: p.effectiveStr });
    return { success: true, subject: mail.subject, html: mail.html };
  } catch (e) { return { success: false, msg: e.message }; }
}

/**
 * Sends the late-fee announcement and (optionally) switches the fee on for every loan that still has a
 * balance, from the announced start date. With `testTo` it only sends one sample email and changes nothing.
 */
async function sendLateFeeNotice(d) {
  try {
    const p = parseNoticeInput(d);
    if (p.error) return { success: false, msg: p.error };
    const cfg = await getConfig();
    const tpl = require("./email-templates");
    const audience = await lateFeeAudience();
    const build = (e) => tpl.lateFeeNoticeEmail(cfg, { name: e.name, loans: e.loans, amount: p.amount, effectiveStr: p.effectiveStr });

    if (d.testTo) return await sendTestAnnouncement(d.testTo, build(audience[0] || SAMPLE_RECIPIENT));
    if (!audience.length) return { success: false, msg: "No borrower has an active loan right now." };

    let applied = null;
    if (d.applyToLoans) {
      const ids = audience.flatMap((e) => e.loanIds);
      for (const id of ids) {
        const { error } = await db().from("loans").update({ late_fee: p.amount, late_fee_from: p.iso }).eq("id", id);
        if (error) {
          return { success: false, msg: /late_fee/i.test(error.message)
            ? "Run late-fee.sql in the Supabase SQL editor first, then send the announcement again. Nothing was sent."
            : error.message };
        }
      }
      await saveConfig({ LATE_FEE_DEFAULT: String(p.amount) });   // new loans start with the same fee
      applied = ids.length;
    }
    return { success: true, ...(await broadcast({ audience, build })), appliedToLoans: applied };
  } catch (e) { return { success: false, msg: e.message }; }
}

/* ---------------- scheduled jobs (called by /api/cron) ---------------- */

/** Loads every loan with its live ledger, once, for the batch jobs. */
async function allLoansLive() {
  const cfg = await getConfig();
  const penaltyRate = Number(cfg.PENALTY_RATE) || 0;
  const banksById = await allBanksById();
  const { data: loans } = await db().from("loans").select("*, borrowers(*)").order("id");
  const paymentsMap = await paymentsForLoans((loans || []).map((l) => l.id));
  return (loans || []).map((l) => ({
    row: l, fig: liveLoanFigures(toEngineLoan(l, banksById), paymentsMap.get(l.id) || [], penaltyRate),
  }));
}

/** Reminders for anything due within 3 days. Settled loans are never touched. */
/**
 * Loan ids that already received a successfully-sent email of this type since
 * midnight in Manila. The scheduled job uses it so that a second run on the same
 * day -- Vercel's Run button, a retry, or the scheduled run landing after a manual
 * one -- never sends a borrower the same reminder twice. If the log can't be read
 * it returns an empty set: better to send than to silently skip.
 *
 * today() carries Manila's calendar date as UTC fields, so Manila midnight is that
 * date at 00:00 UTC minus the UTC+8 offset (the Philippines has no daylight saving).
 */
async function loanIdsEmailedToday(type) {
  try {
    const t = today();
    const manilaMidnight = new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) - 8 * 3600 * 1000);
    const { data, error } = await db().from("email_log").select("loan_id")
      .eq("email_type", type).eq("status", "sent").gte("created_at", manilaMidnight.toISOString());
    if (error) return new Set();
    return new Set((data || []).map((r) => r.loan_id).filter(Boolean));
  } catch (e) { return new Set(); }
}

async function runDueReminders(opts) {
  const done = opts && opts.skipAlreadySentToday ? await loanIdsEmailedToday("reminder") : new Set();
  const results = [];
  for (const { row, fig } of await allLoansLive()) {
    if (fig.balance <= 0 || !fig.next) continue;
    const days = Math.ceil((day0(new Date(fig.next.dueDateObj)) - today()) / 86400000);
    if (days < 0 || days > 3) continue;
    if (done.has(row.id)) { results.push({ loan: row.id, result: "Skipped \u2014 already reminded today." }); continue; }
    results.push({ loan: row.id, result: await sendDueDateReminder(row.id) });
  }
  return results;
}
async function runMonthlyStatements(opts) {
  const done = opts && opts.skipAlreadySentToday ? await loanIdsEmailedToday("statement") : new Set();
  const { data: banks } = await db().from("banks").select("id, statement_day");
  const dayByBank = new Map((banks || []).map((b) => [b.id, b.statement_day]));
  const todayDay = today().getDate();
  const results = [];
  for (const { row, fig } of await allLoansLive()) {
    if (fig.balance <= 0 || !row.bank_id) continue;
    if (dayByBank.get(row.bank_id) !== todayDay) continue;
    if (done.has(row.id)) { results.push({ loan: row.id, result: "Skipped \u2014 statement already sent today." }); continue; }
    results.push({ loan: row.id, result: await sendMonthlyStatement(row.id) });
  }
  return results;
}

module.exports = {
  getConfig, saveConfig, resetConfigToDefaults,
  setBankCost, getBankList, addBankEntry, updateBankEntry, deleteBankEntry,
  validateLogin, changeUserPassword, resetPasswordToDefault, auditWeakPasswords, resetWeakPasswords, getUsersList, updateUserAdmin,
  getAdminBorrowerList, getAdminBorrowerDetail, getBorrowerData, getBorrowerPersonalDetails, getPortalInfo,
  addNewBorrower, addLoanToExistingBorrower, updateBorrower, deleteBorrower,
  recordPayment, sendPaymentReceipt,
  getBillingSchedule, getBillingScheduleByEmail, getDocumentHtml,
  getAdvancedReport, getCollectionHistory,
  getCreditScores, getCreditScore, getLendingGuide,
  auditLoanTerms, fixLoanAmortizations, getEmailLog, getEmailLogEntry,
  sendWelcomeEmail, sendNewLoanNotification, sendMonthlyStatement, sendDueDateReminder,
  runDueReminders, runMonthlyStatements,
  getLateFeeNoticeInfo, previewLateFeeNotice, sendLateFeeNotice,
  getAnnouncementAudience, previewAnnouncement, sendAnnouncement,
};
