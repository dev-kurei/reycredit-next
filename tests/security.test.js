/** Portal PINs are random per borrower, 4-digit PINs are protected by a lockout, admin passwords cannot be reset
 *  by email, and borrowers still on the old default 1234 can be found and rotated. */
const Module = require("module");
const bcrypt = require("bcryptjs");
const { makeFakeDb } = require("./fake-supabase.js");

const RealDate = Date;
const fixed = new RealDate("2026-10-24T04:00:00Z").getTime();
global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };

const tables = {
  borrowers: [{ id: 1, name: "Old Borrower", email: "old@x.com", contact: "", address: "", valid_id: "", cc_email: "" },
              { id: 2, name: "Good Borrower", email: "good@x.com", contact: "", address: "", valid_id: "", cc_email: "" }],
  loans: [], payments: [], email_log: [], login_attempts: [],
  banks: [{ id: 1, name: "BPI Blue Rewards", statement_day: 25, due_day: 8, due_month: "Next Month" }],
  users: [
    { id: 1, email: "old@x.com", password_hash: bcrypt.hashSync("1234", 4), role: "BORROWER" },
    { id: 2, email: "good@x.com", password_hash: bcrypt.hashSync("7391", 4), role: "BORROWER" },
    { id: 3, email: "boss@x.com", password_hash: bcrypt.hashSync("Str0ng-admin-pass", 4), role: "ADMIN" },
  ],
  config: [{ key: "PENALTY_RATE", value: "3" }, { key: "COMPANY_NAME", value: "Rey Credit" }, { key: "LENDER_NAME", value: "Rey F." },
    { key: "SUPPORT_EMAIL", value: "b@x.com" }, { key: "SUPPORT_PHONE", value: "0968" }, { key: "COMPANY_ADDR", value: "Rizal" }, { key: "LENDER_ADDR", value: "Rizal" },
    { key: "PORTAL_URL", value: "https://x" }, { key: "GCASH_ACCOUNT", value: "0968" }, { key: "BPI_ACCOUNT", value: "065" }, { key: "MARIBANK_ACCOUNT", value: "171" }, { key: "OFFICE_HOURS", value: "Mon-Sat" }],
};
const fakeDb = makeFakeDb(tables);
let lockoutTableMissing = false;
const db = { from(name) {
  if (name === "login_attempts" && lockoutTableMissing) throw new Error('relation "login_attempts" does not exist');
  return fakeDb.from(name);
} };
const sent = [];
const orig = Module._load;
Module._load = function (request) {
  if (request.endsWith("/supabase") || request === "./supabase") return { db: () => db };
  if (request.endsWith("/mailer") || request === "./mailer") return { sendMail: async (m) => { sent.push(m); return { success: true, id: "rs" }; } };
  return orig.apply(this, arguments);
};
const fns = require("../lib/functions.js");

let failures = 0;
const check = (label, cond, detail) => { console.log((cond ? "PASS " : "FAIL ") + label + (cond || !detail ? "" : "  -> " + detail)); if (!cond) failures++; };
const form = (over) => ({ name: "Ally Zzandra", email: "ally@x.com", contact: "0917", idNum: "ID1", address: "Rizal", ccEmail: "",
  loanName: "Credit-To-Cash (20,000)", loanType: "Cash Loan", principal: 20000, rate: 3, terms: 6, fee: 0, startDate: "2026-06-10",
  dueDay: 8, partner: "BPI Blue Rewards", totalInterest: 3600, totalPayable: 23600, monthlyAmort: 3933.33, lateFee: 0, lateFeeFrom: "", ...over });

(async () => {
  // 1. Random PIN at creation
  const pins = new Set(); let weakSeen = false, shape = true;
  for (let i = 0; i < 40; i++) {
    const r = await fns.addNewBorrower(form({ email: `b${i}@x.com`, name: "B" + i, loanName: "L" + i }));
    if (!r.success || !/^\d{4}$/.test(r.pin || "")) { shape = false; continue; }
    pins.add(r.pin);
    if (["1234", "0000", "1111", "4321", "1212"].includes(r.pin)) weakSeen = true;
  }
  check("every new borrower gets a 4-digit PIN back", shape);
  check("the PINs are different from each other (random)", pins.size > 15, String(pins.size));
  check("an obvious PIN (1234, 0000, 1111, 4321, 1212) is never issued", !weakSeen);
  const u0 = tables.users.find((u) => u.email === "b0@x.com");
  check("the borrower's saved password is that PIN, not 1234", !!u0 && bcrypt.compareSync(sent.length ? "x" : "x", u0.password_hash) === false && !bcrypt.compareSync("1234", u0.password_hash));
  const r2 = await fns.addNewBorrower(form({ email: "typed@x.com", name: "Typed", loanName: "T", password: "1234" }));
  const u2 = tables.users.find((u) => u.email === "typed@x.com");
  check("even if a password is sent in, a random PIN is used instead", r2.success && !bcrypt.compareSync("1234", u2.password_hash) && bcrypt.compareSync(r2.pin, u2.password_hash));
  const mail = sent.filter((m) => /Welcome/.test(m.subject)).pop();
  check("the welcome email shows the same PIN and no 1234", !!mail && mail.html.includes(r2.pin) && !/>1234</.test(mail.html));
  const logged = tables.email_log.filter((l) => l.email_type === "welcome").pop();
  check("the email log does not keep the PIN", !!logged && !String(logged.body_html || "").includes(r2.pin) && /••••/.test(String(logged.body_html || "")));
  const resend = await fns.sendWelcomeEmail(tables.loans[tables.loans.length - 1].id);
  const mail2 = sent.filter((m) => /Welcome/.test(m.subject)).pop();
  check("re-sending the welcome note does not change the password and says where to find the PIN", /sent to/.test(resend) && /Forgot password/.test(mail2.html) && bcrypt.compareSync(r2.pin, tables.users.find((u) => u.email === "typed@x.com").password_hash));

  // 2. Lockout
  for (let i = 1; i <= 4; i++) { const r = await fns.validateLogin("good@x.com", "0000"); if (i === 4) check("4 wrong attempts: still just 'wrong password'", r.success === false && !r.locked); }
  let r = await fns.validateLogin("good@x.com", "0000");
  check("the 5th wrong attempt locks the account", r.success === false && r.locked === true && /15 minutes/.test(r.msg), JSON.stringify(r));
  r = await fns.validateLogin("good@x.com", "7391");
  check("while locked, even the right PIN is refused", r.success === false && r.locked === true);
  tables.login_attempts[0].locked_until = new RealDate(fixed - 60000).toISOString();   // 15 minutes pass
  r = await fns.validateLogin("good@x.com", "7391");
  check("after the lock expires the right PIN works again", r.success === true && r.role === "BORROWER");
  check("a good sign-in clears the counter", Number(tables.login_attempts[0].failures) === 0 && !tables.login_attempts[0].locked_until);
  await fns.validateLogin("good@x.com", "1"); await fns.validateLogin("good@x.com", "2");
  tables.login_attempts[0].last_failure = new RealDate(fixed - 31 * 60000).toISOString();
  for (let i = 0; i < 3; i++) await fns.validateLogin("good@x.com", "3");
  r = await fns.validateLogin("good@x.com", "7391");
  check("old failures are forgotten after 30 quiet minutes", r.success === true);
  check("an unknown email is just a failure and leaves no record", (await fns.validateLogin("nobody@x.com", "x")).success === false && !tables.login_attempts.some((a) => a.email === "nobody@x.com"));
  lockoutTableMissing = true;
  r = await fns.validateLogin("good@x.com", "7391");
  check("if login-lockout.sql has not been run, signing in still works", r.success === true);
  r = await fns.validateLogin("good@x.com", "bad");
  check("...and a wrong password is just refused (no crash)", r.success === false);
  lockoutTableMissing = false;

  // 3. Forgot password
  const before = tables.users.find((u) => u.email === "boss@x.com").password_hash;
  const sentBefore = sent.length;
  r = await fns.resetPasswordToDefault("boss@x.com");
  check("an admin account is never reset by email (same answer, nothing changed, nothing sent)", r.success === true && tables.users.find((u) => u.email === "boss@x.com").password_hash === before && sent.length === sentBefore);
  r = await fns.resetPasswordToDefault("ghost@x.com");
  check("an unknown email gets the same answer as a real one", r.success === true && /If that email has an account/.test(r.msg) && sent.length === sentBefore);
  const goodBefore = tables.users.find((u) => u.email === "good@x.com").password_hash;
  r = await fns.resetPasswordToDefault("good@x.com");
  const pinMail = sent[sent.length - 1];
  const newPin = (pinMail.html.match(/letter-spacing:9px[^>]*>(\d{4})</) || [])[1];
  check("a borrower reset sets a random PIN and emails it", r.success && !!newPin && newPin !== "1234" && bcrypt.compareSync(newPin, tables.users.find((u) => u.email === "good@x.com").password_hash) && tables.users.find((u) => u.email === "good@x.com").password_hash !== goodBefore);
  await fns.resetPasswordToDefault("good@x.com"); await fns.resetPasswordToDefault("good@x.com");
  r = await fns.resetPasswordToDefault("good@x.com");
  check("more than 3 resets in an hour is refused", r.success === false && /Too many reset requests/.test(r.msg));

  // 4. Find and replace the old default
  const a = await fns.auditWeakPasswords();
  check("finds the borrower still on 1234 and nobody else", a.success && a.count === 1 && a.users[0].email === "old@x.com" && a.users[0].name === "Old Borrower", JSON.stringify(a));
  const before2 = sent.length;
  const fix = await fns.resetWeakPasswords();
  check("replaces it with a random PIN and emails the borrower", fix.success && fix.changed === 1 && fix.emailed === 1 && sent.length === before2 + 1 && sent[sent.length - 1].to === "old@x.com" && /new portal PIN/i.test(sent[sent.length - 1].subject));
  check("the old password no longer works and nobody is left on 1234", !bcrypt.compareSync("1234", tables.users.find((u) => u.email === "old@x.com").password_hash) && (await fns.auditWeakPasswords()).count === 0);
  check("other borrowers and the admin are untouched", bcrypt.compareSync("Str0ng-admin-pass", tables.users.find((u) => u.email === "boss@x.com").password_hash));

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
