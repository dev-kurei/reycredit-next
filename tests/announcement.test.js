/** The general announcement: the admin's own words, safely rendered, to the right people, never twice by accident. */
process.env.NOTICE_SEND_DELAY_MS = "0";
const Module = require("module");
const { makeFakeDb } = require("./fake-supabase.js");

const RealDate = Date;
const fixed = new RealDate("2026-10-09T04:00:00Z").getTime();
global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };

const loan = (id, borrower_id, name, extra) => ({ id, borrower_id, loan_name: name, loan_type: "Cash Loan", start_date: "2026-08-20", principal: 1000, terms: 3, monthly_rate: 0,
  processing_fee: 0, total_interest: 0, total_payable: 3000, monthly_amort: 1000, bank_id: null, due_day: 8, closed: false, late_fee: 0, late_fee_from: null, ...extra });
const tables = {
  borrowers: [
    { id: 1, name: "Ally <b>Z</b>", email: "ally@x.com", contact: "", address: "", valid_id: "", cc_email: "" },     // overdue (started Aug 20, nothing paid)
    { id: 2, name: "Venah", email: "venah@x.com", contact: "", address: "", valid_id: "", cc_email: "" },             // current: first bill not due yet
    { id: 3, name: "Done Dan", email: "dan@x.com", contact: "", address: "", valid_id: "", cc_email: "" },           // fully paid
  ],
  banks: [],
  loans: [loan(10, 1, "Honor"), loan(20, 2, "Airline", { start_date: "2026-10-05" }), loan(30, 3, "Paid off", { terms: 1, total_payable: 1000 })],
  payments: [{ id: 1, loan_id: 30, for_month: "September 2026", amount: 1000, paid_date: "2026-09-08", receipt_no: "R1", method: "GCash" }],
  users: [], email_log: [],
  config: [{ key: "PENALTY_RATE", value: "3" }, { key: "COMPANY_NAME", value: "Rey Credit" }, { key: "SUPPORT_EMAIL", value: "b@x.com" },
    { key: "SUPPORT_PHONE", value: "0968" }, { key: "COMPANY_ADDR", value: "Rizal" }, { key: "PORTAL_URL", value: "https://x" }],
};
const fakeDb = makeFakeDb(tables);
const sent = [];
const orig = Module._load;
Module._load = function (request) {
  if (request.endsWith("/supabase") || request === "./supabase") return { db: () => fakeDb };
  if (request.endsWith("/mailer") || request === "./mailer") return { sendMail: async (m) => { sent.push(m); return { success: true, id: "rs" + sent.length }; } };
  return orig.apply(this, arguments);
};
const fns = require("../lib/functions.js");

let failures = 0;
const check = (label, cond, detail) => { console.log((cond ? "PASS " : "FAIL ") + label + (cond || !detail ? "" : "  -> " + detail)); if (!cond) failures++; };
const msg = { subject: "Office closed on Oct 31", message: "We are closed on Oct 31.\n\nPay by GCash anytime, {name}.\nRef: <script>alert(1)</script> for {loans}.", audience: "active" };

(async () => {
  const a = await fns.getAnnouncementAudience("active"), o = await fns.getAnnouncementAudience("overdue"), e = await fns.getAnnouncementAudience("everyone");
  check("active = anyone who still owes (2), settled one left out", a.borrowers === 2, JSON.stringify(a));
  check("overdue = only the borrower who is actually overdue (1)", o.borrowers === 1 && o.loans === 1, JSON.stringify(o));
  check("everyone includes the fully paid borrower (3)", e.borrowers === 3, JSON.stringify(e));

  check("a subject is required", (await fns.sendAnnouncement({ ...msg, subject: " " })).success === false);
  check("a message is required", (await fns.sendAnnouncement({ ...msg, message: "" })).success === false);
  check("nothing sent by the refusals", sent.length === 0);

  const pv = await fns.previewAnnouncement(msg);
  check("preview renders the admin's words", pv.success && /We are closed on Oct 31/.test(pv.html) && /Office closed on Oct 31/.test(pv.subject), pv.msg);
  check("preview sends nothing", sent.length === 0);
  check("blank line = new paragraph, single newline = line break", (pv.html.match(/We are closed on Oct 31/g) || []).length >= 1 && /Pay by GCash anytime/.test(pv.html));
  check("typed markup is escaped, never run", !/<script>alert/.test(pv.html) && /&lt;script&gt;/.test(pv.html));
  check("a borrower's name with markup is escaped too", !/Hi Ally <b>/.test(pv.html) && /Hi Ally &lt;b&gt;Z&lt;\/b&gt;/.test(pv.html));
  check("{name} and {loans} are filled in", /anytime, Ally/.test(pv.html) && /for Honor\./.test(pv.html));
  check("portal button included by default", /Open my portal/.test(pv.html));
  const nb = await fns.previewAnnouncement({ ...msg, button: false });
  check("the button can be left out", !/Open my portal/.test(nb.html));

  const t = await fns.sendAnnouncement({ ...msg, testTo: "me@x.com" });
  check("test goes only to the given address, marked [TEST]", t.success && sent.length === 1 && String(sent[0].to) === "me@x.com" && /^\[TEST\]/.test(sent[0].subject));

  sent.length = 0;
  const r = await fns.sendAnnouncement(msg);
  check("sends to the active borrowers only", r.success && r.sent === 2 && sent.length === 2 && !sent.some((m) => String(m.to) === "dan@x.com"), JSON.stringify(r));
  check("each email is personal", sent.some((m) => /anytime, Ally/.test(m.html)) && sent.some((m) => /anytime, Venah/.test(m.html)));
  check("logged with content", tables.email_log.filter((l) => l.email_type === "announcement" && !/TEST/.test(l.subject)).length === 2);

  sent.length = 0;
  const again = await fns.sendAnnouncement(msg);
  check("the same subject is not sent twice", again.sent === 0 && again.skipped === 2 && sent.length === 0, JSON.stringify(again));
  const forced = await fns.sendAnnouncement({ ...msg, resendAll: true });
  check("...unless 'send again' is ticked", forced.sent === 2 && sent.length === 2);

  sent.length = 0;
  const od = await fns.sendAnnouncement({ ...msg, subject: "Please settle your overdue", audience: "overdue" });
  check("overdue audience reaches only the overdue borrower", od.sent === 1 && String(sent[0].to) === "ally@x.com", JSON.stringify(od));
  const ev = await fns.sendAnnouncement({ ...msg, subject: "Thank you all", audience: "everyone" });
  check("everyone includes the fully paid borrower", ev.sent === 3);

  global.Date = RealDate;
  console.log(failures ? "\nFAILED: " + failures : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { global.Date = RealDate; console.error(e); process.exit(1); });
