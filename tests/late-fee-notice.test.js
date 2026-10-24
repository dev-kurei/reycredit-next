/** The late-fee announcement: right audience, one email per borrower, switches the fee on, safe to repeat. */
process.env.NOTICE_SEND_DELAY_MS = "0";
const Module = require("module");
const { makeFakeDb } = require("./fake-supabase.js");

const RealDate = Date;
function setToday(iso) {
  const fixed = new RealDate(iso + "T04:00:00Z").getTime();
  global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
}
setToday("2026-10-09");

const loan = (id, borrower_id, name, extra) => ({ id, borrower_id, loan_name: name, loan_type: "Cash Loan", start_date: "2026-08-20", principal: 1000, terms: 3, monthly_rate: 0,
  processing_fee: 0, total_interest: 0, total_payable: 3000, monthly_amort: 1000, bank_id: null, due_day: 8, closed: false, late_fee: 0, late_fee_from: null, ...extra });
const tables = {
  borrowers: [
    { id: 1, name: "Ally", email: "ally@x.com", contact: "", address: "", valid_id: "", cc_email: "ally.cc@x.com" },
    { id: 2, name: "Venah", email: "venah@x.com", contact: "", address: "", valid_id: "", cc_email: "" },
    { id: 3, name: "Done Dan", email: "dan@x.com", contact: "", address: "", valid_id: "", cc_email: "" },
  ],
  banks: [],
  loans: [loan(10, 1, "Honor"), loan(11, 1, "Phone"), loan(20, 2, "Airline"), loan(30, 3, "Paid off", { terms: 1, total_payable: 1000 })],
  payments: [{ id: 1, loan_id: 30, for_month: "September 2026", amount: 1000, paid_date: "2026-09-08", receipt_no: "R1", method: "GCash" }],
  users: [], email_log: [],
  config: [{ key: "PENALTY_RATE", value: "3" }, { key: "COMPANY_NAME", value: "Rey Credit" }, { key: "LENDER_NAME", value: "Rey F." }, { key: "SUPPORT_EMAIL", value: "b@x.com" },
    { key: "SUPPORT_PHONE", value: "0968" }, { key: "COMPANY_ADDR", value: "Rizal" }, { key: "PORTAL_URL", value: "https://x" }],
};
const fakeDb = makeFakeDb(tables);
let columnsMissing = false;
const db = { from(name) {
  const b = fakeDb.from(name);
  if (name !== "loans") return b;
  const update = b.update.bind(b);
  b.update = (p) => (columnsMissing && "late_fee" in p
    ? { eq: () => Promise.resolve({ data: null, error: { message: 'column "late_fee" does not exist' } }) } : update(p));
  return b;
} };

const sent = []; let failFor = null;
const orig = Module._load;
Module._load = function (request) {
  if (request.endsWith("/supabase") || request === "./supabase") return { db: () => db };
  if (request.endsWith("/mailer") || request === "./mailer") return { sendMail: async (m) => {
    if (failFor && [].concat(m.to).includes(failFor)) return { success: false, msg: "mailbox full" };
    sent.push(m); return { success: true, id: "rs" + sent.length };
  } };
  return orig.apply(this, arguments);
};
const fns = require("../lib/functions.js");

let failures = 0;
const check = (label, cond, detail) => { console.log((cond ? "PASS " : "FAIL ") + label + (cond || !detail ? "" : "  -> " + detail)); if (!cond) failures++; };
const base = { amount: 200, effectiveDate: "2026-10-24", applyToLoans: true };

(async () => {
  const info = await fns.getLateFeeNoticeInfo();
  check("audience = borrowers with a balance (the paid-off one is left out)", info.borrowers === 2 && info.loans === 3, JSON.stringify(info));

  check("amount is required", (await fns.sendLateFeeNotice({ ...base, amount: 0 })).success === false);
  check("a date in the past is refused", (await fns.sendLateFeeNotice({ ...base, effectiveDate: "2026-10-01" })).success === false);
  check("nothing was sent or changed by the refusals", sent.length === 0 && tables.loans.every((l) => l.late_fee === 0));

  const pv = await fns.previewLateFeeNotice(base);
  check("preview shows the fee and the start date", pv.success && /₱200\.00/.test(pv.html) && /October 24, 2026/.test(pv.html) && /Honor/.test(pv.html), pv.msg);
  check("preview sends nothing", sent.length === 0);
  check("notice carries the legal basis (Civil Code, Truth in Lending, SEC reference) and asks for agreement", /Legal basis/.test(pv.html) && /Article[s]? 1306/.test(pv.html) && /R\.A\. 3765/.test(pv.html) && /Memorandum Circular 3/.test(pv.html) && /not legal advice/.test(pv.html) && /I agree/.test(pv.html));

  const t = await fns.sendLateFeeNotice({ ...base, testTo: "me@x.com" });
  check("test goes only to the address given", t.success && sent.length === 1 && String(sent[0].to) === "me@x.com", JSON.stringify(sent.map((m) => m.to)));
  check("...is marked as a test", /^\[TEST\]/.test(sent[0].subject));
  check("...and does not switch the fee on", tables.loans.every((l) => l.late_fee === 0));

  sent.length = 0;
  const r = await fns.sendLateFeeNotice(base);
  check("sends one email per borrower, not per loan", r.success && r.sent === 2 && sent.length === 2, JSON.stringify(r));
  check("the borrower with two loans gets both listed in one email", /Honor/.test(sent[0].html) && /Phone/.test(sent[0].html));
  check("borrower's CC address is copied", String(sent[0].cc) === "ally.cc@x.com");
  check("the paid-off borrower is not emailed", !sent.some((m) => String(m.to) === "dan@x.com"));
  const active = tables.loans.filter((l) => l.id !== 30);
  check("fee switched on for every active loan from the start date", active.every((l) => Number(l.late_fee) === 200 && l.late_fee_from === "2026-10-24"), JSON.stringify(active.map((l) => [l.late_fee, l.late_fee_from])));
  check("...but not for the paid-off loan", tables.loans.find((l) => l.id === 30).late_fee === 0);
  check("the Settings default for new loans is updated", (await fns.getConfig()).LATE_FEE_DEFAULT === "200");
  const logged = tables.email_log.filter((e) => e.email_type === "announcement" && !/TEST/.test(e.subject));
  check("each send is in the Email log with its content", logged.length === 2 && logged.every((e) => e.status === "sent" && /late payment fee/i.test(e.body_html)));

  sent.length = 0;
  const again = await fns.sendLateFeeNotice(base);
  check("pressing it again sends nothing new", again.sent === 0 && again.skipped === 2 && sent.length === 0, JSON.stringify(again));

  const changed = await fns.sendLateFeeNotice({ ...base, amount: 250 });
  check("a different amount is a new announcement", changed.sent === 2 && sent.length === 2);

  // A failure for one borrower is reported and retried, without re-sending to the rest.
  sent.length = 0; failFor = "venah@x.com";
  const f = await fns.sendLateFeeNotice({ ...base, amount: 300, applyToLoans: false });
  check("one failure is reported, the others still go", f.sent === 1 && f.failed === 1 && f.failures[0].name === "Venah" && /mailbox full/.test(f.failures[0].msg), JSON.stringify(f));
  check("applyToLoans off leaves the loans alone (still the earlier P250)", Number(tables.loans.find((l) => l.id === 10).late_fee) === 250);
  failFor = null; sent.length = 0;
  const retry = await fns.sendLateFeeNotice({ ...base, amount: 300, applyToLoans: false });
  check("retry sends only to the one that failed", retry.sent === 1 && retry.skipped === 1 && String(sent[0].to) === "venah@x.com", JSON.stringify(retry));

  // Database without late-fee.sql: nothing is sent, and the admin is told why.
  columnsMissing = true; sent.length = 0;
  const miss = await fns.sendLateFeeNotice({ ...base, amount: 400 });
  check("without late-fee.sql nothing is sent", miss.success === false && /late-fee\.sql/.test(miss.msg) && sent.length === 0, JSON.stringify(miss));

  global.Date = RealDate;
  console.log(failures ? "\nFAILED: " + failures : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { global.Date = RealDate; console.error(e); process.exit(1); });
