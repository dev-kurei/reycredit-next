/** End to end: the late fee is saved per loan, reaches the agreement, SOA and emails, and a database
 *  that has not had late-fee.sql run yet still saves everything else. */
const Module = require("module");
const { makeFakeDb } = require("./fake-supabase.js");

const RealDate = Date;
function setToday(iso) {
  const fixed = new RealDate(iso + "T04:00:00Z").getTime();
  global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
}
setToday("2026-10-09");

const tables = {
  borrowers: [], loans: [], payments: [], users: [], email_log: [],
  banks: [{ id: 1, name: "BPI Blue Rewards", statement_day: 25, due_day: 8, due_month: "Next Month" }],
  config: [{ key: "PENALTY_RATE", value: "3" }, { key: "COMPANY_NAME", value: "Rey Credit" }, { key: "LENDER_NAME", value: "Rey F." },
    { key: "SUPPORT_EMAIL", value: "b@x.com" }, { key: "SUPPORT_PHONE", value: "0968" }, { key: "COMPANY_ADDR", value: "Rizal" }, { key: "LENDER_ADDR", value: "Rizal" },
    { key: "PORTAL_URL", value: "https://x" }, { key: "GCASH_ACCOUNT", value: "0968" }, { key: "BPI_ACCOUNT", value: "065" }, { key: "MARIBANK_ACCOUNT", value: "171" }, { key: "OFFICE_HOURS", value: "Mon-Sat" }],
};
const fakeDb = makeFakeDb(tables);

let columnsMissing = false;
const db = { from(name) {
  const b = fakeDb.from(name);
  if (name !== "loans") return b;
  const update = b.update.bind(b);
  b.update = (p) => {
    if (columnsMissing && ("late_fee" in p || "late_fee_from" in p)) {
      const r = { eq: () => Promise.resolve({ data: null, error: { message: 'column "late_fee" of relation "loans" does not exist' } }) };
      return r;
    }
    return update(p);
  };
  return b;
} };

const sent = [];
const orig = Module._load;
Module._load = function (request) {
  if (request.endsWith("/supabase") || request === "./supabase") return { db: () => db };
  if (request.endsWith("/mailer") || request === "./mailer") return { sendMail: async (m) => { sent.push(m); return { success: true, id: "rs" }; } };
  return orig.apply(this, arguments);
};
const fns = require("../lib/functions.js");
const { buildAgreementHtml, buildSoaHtml } = require("../lib/documents.js");
const { buildSchedule } = require("../lib/engine.js");

let failures = 0;
const check = (label, cond, detail) => { console.log((cond ? "PASS " : "FAIL ") + label + (cond || !detail ? "" : "  -> " + detail)); if (!cond) failures++; };

const form = (over) => ({ name: "Ally Zzandra", email: "ally@x.com", contact: "0917", idNum: "ID1", address: "Rizal", ccEmail: "",
  loanName: "Credit-To-Cash (20,000)", loanType: "Cash Loan", principal: 20000, rate: 3, terms: 6, fee: 0, startDate: "2026-06-10",
  dueDay: 8, partner: "BPI Blue Rewards", totalInterest: 3600, totalPayable: 23600, monthlyAmort: 3933.33, lateFee: 0, lateFeeFrom: "", ...over });

(async () => {
  // 1. A new loan with a late fee stores it and the welcome agreement shows it.
  let r = await fns.addNewBorrower(form({ lateFee: 200 }));
  const loan = tables.loans[0];
  check("new loan saves with a late fee", r.success && Number(loan.late_fee) === 200 && !loan.late_fee_from, JSON.stringify([r.msg, loan]));
  const d = await fns.getAdminBorrowerDetail(loan.id);
  check("loan detail reports the late fee", d.lateFee === 200 && d.lateFeeFromISO === "", JSON.stringify([d.lateFee, d.lateFeeFromISO]));

  const cfg = await fns.getConfig();
  const bank = { name: "BPI Blue Rewards", statementDay: 25, dueDay: 8, sameMonth: false };
  const row = { ...loan, borrowers: tables.borrowers[0] };
  const agr = buildAgreementHtml(cfg, row, bank);
  check("agreement lists the late payment fee", /Late payment fee<\/td><td>₱200\.00 per late month/.test(agr));
  check("agreement clause states the fee and the separate-overdue rule", /flat late payment fee of ₱200\.00/.test(agr) && /itemized separately/.test(agr));
  check("agreement has the acknowledgment clause and says unpaid charges carry the next penalty", /Acknowledgment of charges/.test(agr) && /freely agreed to/.test(agr) && /only the excess shall be reduced/.test(agr) && /expressly stipulated/.test(agr));
  const noFee = buildAgreementHtml(cfg, { ...row, late_fee: 0 }, bank);
  check("...and a loan without a late fee is left as it was", !/Acknowledgment of charges/.test(noFee));
  check("a loan with no late fee keeps the original agreement wording", !/late payment fee/i.test(noFee) && /incurs a penalty of 3% per month on the overdue amount\./.test(noFee));
  const { renderAgreementPdf } = require("../lib/pdf-documents.js");
  const pdf = await renderAgreementPdf(cfg, row, bank);
  check("agreement PDF still renders with the fee", Buffer.isBuffer(pdf) && pdf.length > 3000 && pdf.slice(0, 4).toString() === "%PDF", String(pdf && pdf.length));

  // 2. Email carries the fee.
  const welcome = sent.find((m) => /Welcome/.test(m.subject));
  check("welcome email was sent with the agreement attached", !!welcome && welcome.attachments && welcome.attachments.length === 1);

  const tpl = require("../lib/email-templates.js");
  const rem = tpl.reminderEmail(cfg, { name: "Ally", loanName: "L", amount: 3933.33, dueStr: "November 08, 2026", days: 30, balance: 9000, remaining: 5, hasCarry: false, carryAmount: 0, lateFee: 200, overdueSeparate: 3965.15, mergesOn: "October 25, 2026" });
  check("reminder shows the overdue on its own line with the merge date", /Also overdue/.test(rem.html) && /3,965\.15/.test(rem.html) && /October 25, 2026/.test(rem.html));
  check("reminder names the flat late fee", /flat late payment fee of <strong>\u20B1200\.00/.test(rem.html));
  check("a reminder for a loan without a late fee is unchanged", !/late payment fee/i.test(tpl.reminderEmail(cfg, { name: "A", loanName: "L", amount: 1, dueStr: "x", days: 3, balance: 1, remaining: 1, hasCarry: false, carryAmount: 0 }).html));
  const nl = tpl.newLoanEmail(cfg, { name: "A", loanName: "L", principal: 1, monthlyRate: "3%", fee: 0, totalInterest: 0, totalPayable: 1, terms: 1, monthlyAmort: 1, dueDateStr: "x", lateFee: 200 });
  check("new-loan email lists the late fee", /Late payment fee/.test(nl.html) && /\u20B1200\.00 per late month/.test(nl.html));

  // 3. Adding a fee to a running loan applies from today unless a date is given.
  r = await fns.addNewBorrower(form({ name: "Venah", email: "venah@x.com", loanName: "Credit-To-Cash (20K)", lateFee: 0 }));
  const venah = tables.loans[1];
  check("a loan without a late fee has none stored", r.success && !Number(venah.late_fee));
  r = await fns.updateBorrower(venah.id, form({ name: "Venah", email: "venah@x.com", loanName: "Credit-To-Cash (20K)", lateFee: 150 }));
  check("a fee added later starts from today, not retroactively", r.success && Number(venah.late_fee) === 150 && venah.late_fee_from === "2026-10-09", JSON.stringify([venah.late_fee, venah.late_fee_from]));
  r = await fns.updateBorrower(venah.id, form({ name: "Venah", email: "venah@x.com", loanName: "Credit-To-Cash (20K)", lateFee: 150, lateFeeFrom: "2026-09-01" }));
  check("an explicit start date is honoured", venah.late_fee_from === "2026-09-01", String(venah.late_fee_from));
  r = await fns.updateBorrower(venah.id, form({ name: "Venah", email: "venah@x.com", loanName: "Credit-To-Cash (20K)", lateFee: 0 }));
  check("setting it back to 0 removes the fee and its date", Number(venah.late_fee) === 0 && !venah.late_fee_from);
  r = await fns.updateBorrower(venah.id, form({ name: "Venah", email: "venah@x.com", loanName: "Credit-To-Cash (20K)", lateFee: 0 }));
  check("saving a loan that never had a fee touches nothing", r.success);

  // 4. SOA shows the split.
  const payments = [{ month: "July 2026", amount: 600, date: new RealDate("2026-07-07") }];
  const eng = { id: 1, startDate: new RealDate("2026-06-10"), totalPayable: 6000, terms: 6, monthlyAmort: 1000, processingFee: 0, bank, dueDay: 8, loanName: "x", lateFee: 100, lateFeeFrom: null };
  const built = buildSchedule(eng, payments, 3);
  const soaRow = { ...row, loan_name: "x", late_fee: 100, principal: 6000, total_payable: 6000, total_interest: 0, terms: 6, monthly_rate: 0, processing_fee: 0, start_date: "2026-06-10" };
  const soa = buildSoaHtml(cfg, soaRow, bank, payments, built.schedule);
  check("SOA states the late fee and the separately listed overdue", /flat late payment fee of ₱100\.00/.test(soa) && /listed separately/.test(soa) && /October 25, 2026/.test(soa));
  check("SOA schedule shows what was added (penalty + late fee)", /late fee/.test(soa) && /penalty/.test(soa));

  // 5. Database without late-fee.sql: the loan is still saved and the admin is told what to do.
  columnsMissing = true;
  r = await fns.addNewBorrower(form({ name: "Meliza", email: "meliza@x.com", loanName: "Honor", lateFee: 200 }));
  check("loan is still created when the late-fee columns do not exist yet", r.success && tables.loans.length === 3, JSON.stringify(r));
  check("...and the message says to run late-fee.sql", /late-fee\.sql/.test(r.msg), r.msg);
  r = await fns.addNewBorrower(form({ name: "Plain", email: "plain@x.com", loanName: "Plain", lateFee: 0 }));
  check("a loan with no late fee saves normally on an old database", r.success && !/late-fee\.sql/.test(r.msg), JSON.stringify(r));
  columnsMissing = false;

  global.Date = RealDate;
  console.log(failures ? "\nFAILED: " + failures : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { global.Date = RealDate; console.error(e); process.exit(1); });
