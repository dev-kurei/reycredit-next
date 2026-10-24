/**
 * The percentage penalty and the flat late fee are charged ON THE DUE DATE on whatever was still
 * unpaid then. A later payment settles the bill but never takes the penalty back. Only the
 * instalment itself reduces the loan; penalty and late fee are separate charges.
 */
const { buildSchedule, balanceFrom, nextBillFrom, owedToday } = require("../lib/engine");

const RealDate = Date;
function setToday(iso) {
  const fixed = new RealDate(iso + "T04:00:00Z").getTime();
  global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
}
const D = (s) => new RealDate(s);
let failures = 0;
const check = (label, cond, detail) => { console.log((cond ? "PASS " : "FAIL ") + label + (cond || !detail ? "" : "  -> " + detail)); if (!cond) failures++; };

const bank = { statementDay: 20, dueDay: 8, sameMonth: false };   // Oct bill: statement Sep 20, due Oct 8
const loan = (extra) => ({ id: 1, startDate: D("2026-07-20"), totalPayable: 10000, terms: 4, monthlyAmort: 2500, processingFee: 0, bank, dueDay: 8, loanName: "t", lateFee: 200, penaltyFrom: null, ...extra });
const aug = { month: "August 2026", amount: 2500, date: D("2026-08-08") };
const at = (iso, pays, extra) => { setToday(iso); const b = buildSchedule(loan(extra), pays, 3); return { b, n: nextBillFrom(b), bal: balanceFrom(b.schedule) }; };

// 1. Missed September, before the statement: overdue = 2,500 + 3% (75) + late fee (200), on its own line.
{
  const { n, b } = at("2026-09-09", [aug]);
  const sep = b.schedule[1];
  check("penalty is 3% of the whole missed bill = 75", sep.penalty === 75, String(sep.penalty));
  check("overdue 2,775 shown separately, next payment is October's 2,500", n.overdueSeparate === 2775 && n.bill === 2500, JSON.stringify([n.overdueSeparate, n.bill]));
  check("payment dialog is pointed at the overdue month", n.overdueMonth === "September 2026", n.overdueMonth);
}

// 2. Paid the whole 2,775 late, against September: everything is clear and the 75 stays charged.
{
  const { n, b, bal } = at("2026-09-15", [aug, { month: "September 2026", amount: 2775, date: D("2026-09-10") }]);
  check("late full payment still carries the penalty (75) and fee (200)", b.schedule[1].penalty === 75 && b.schedule[1].lateFee === 200);
  check("nothing overdue afterwards, no stray credit in October", owedToday(b.schedule) === 0 && n.bill === 2500 && n.overdueSeparate === 0, JSON.stringify([owedToday(b.schedule), n.bill]));
  check("balance = remaining Oct+Nov instalments only (5,000)", bal === 5000, String(bal));
}

// 3. Paid only the 2,500 bill late: the instalment is done, the 275 penalty/fee remains on its own line.
{
  const { n, b } = at("2026-09-15", [aug, { month: "September 2026", amount: 2500, date: D("2026-09-10") }]);
  check("only the instalment is cleared; 275 penalty + fee still owed", n.overdueSeparate === 275 && n.bill === 2500, JSON.stringify([n.overdueSeparate, n.bill]));
  check("September instalment itself counts as paid", b.schedule[1].outstanding === 0, String(b.schedule[1].outstanding));
}

// 4. Partial payment after the due date: the penalty is still on the full 2,500, and the dialog gets only what is left.
{
  const { n } = at("2026-09-15", [aug, { month: "September 2026", amount: 1000, date: D("2026-09-10") }]);
  check("1,000 paid late: 1,500 + 75 + 200 = 1,775 left, prefill target", n.overdueSeparate === 1775 && n.overdueMonth === "September 2026", JSON.stringify([n.overdueSeparate, n.overdueMonth]));
}

// 5. Part paid early or on the due date: the penalty is still on the WHOLE bill, not on the rest.
{
  const onDue = at("2026-09-15", [aug, { month: "September 2026", amount: 1000, date: D("2026-09-08") }]);
  check("1,000 on the due date, 1,500 unpaid -> penalty on the full 2,500 = 75", onDue.b.schedule[1].penalty === 75, String(onDue.b.schedule[1].penalty));
  const early = at("2026-09-15", [aug, { month: "September 2026", amount: 2000, date: D("2026-08-25") }]);
  check("2,000 paid in advance, 500 unpaid -> still 75", early.b.schedule[1].penalty === 75, String(early.b.schedule[1].penalty));
  check("...and what is owed is 500 + 75 + 200 = 775", early.n.overdueSeparate === 775, String(early.n.overdueSeparate));
  const full = at("2026-09-15", [aug, { month: "September 2026", amount: 2500, date: D("2026-09-08") }]);
  check("paid in full on the due date -> no penalty, no fee", full.b.schedule[1].penalty === 0 && full.b.schedule[1].lateFee === 0);
}

// 5b. A missed month that is carried into the next one: the next penalty is on the new bill plus the arrears.
{
  const { b } = at("2026-10-09", [aug]);
  check("October unpaid with September still owing: 3% of 2,500 + 2,775 = 158.25", b.schedule[2].penalty === 158.25, String(b.schedule[2].penalty));
  const paidEarly = at("2026-10-09", [aug, { month: "September 2026", amount: 2775, date: D("2026-09-10") }]);
  check("Sept arrears cleared on Sep 10: October's penalty is on 2,500 only = 75", paidEarly.b.schedule[2].penalty === 75, String(paidEarly.b.schedule[2].penalty));
}

// 6. Once the statement is generated the unpaid amount joins the bill.
{
  const { n } = at("2026-09-21", [aug]);
  check("statement date passed: one merged bill of 5,275", n.bill === 5275 && n.overdueSeparate === 0, JSON.stringify([n.bill, n.overdueSeparate]));
  const p = at("2026-09-21", [aug, { month: "September 2026", amount: 1000, date: D("2026-09-10") }]);
  check("...and 4,275 after a 1,000 payment (5,275 - 1,000)", p.n.bill === 4275, String(p.n.bill));
}

// 7. The month label of a payment does not matter for penalties: money received before a due date counts.
{
  const a = at("2026-10-09", [aug, { month: "September 2026", amount: 2775, date: D("2026-09-10") }, { month: "October 2026", amount: 2500, date: D("2026-10-05") }]);
  const c = at("2026-10-09", [aug, { month: "October 2026", amount: 5275, date: D("2026-09-10") }]);
  check("Sep paid late, Oct paid on time -> October is not late", a.b.schedule[2].penalty === 0 && a.b.schedule[2].lateFee === 0, JSON.stringify([a.b.schedule[2].penalty, a.b.schedule[2].lateFee]));
  check("2,775 + 2,500 labelled any way gives the same balance", a.bal === 2500 && c.bal === 2500, JSON.stringify([a.bal, c.bal]));
  check("all 5,275 paid early under October's label -> no charge in October", c.b.schedule[2].penalty === 0 && c.b.schedule[2].lateFee === 0);
}

// 8. Cycles that fell due before the cutoff keep the old rule so balances already quoted do not move.
{
  setToday("2026-10-09");
  const old = buildSchedule(loan({ penaltyFrom: undefined }), [aug, { month: "September 2026", amount: 2500, date: D("2026-09-10") }], 3);
  check("default cutoff (2026-10-10): paid-in-full September had no penalty under the old rule", old.schedule[1].penalty === 0, String(old.schedule[1].penalty));
  const withCut = buildSchedule(loan({ penaltyFrom: D("2026-09-01") }), [aug, { month: "September 2026", amount: 2500, date: D("2026-09-10") }], 3);
  check("with an earlier cutoff the same September carries 75", withCut.schedule[1].penalty === 75, String(withCut.schedule[1].penalty));
  setToday("2026-11-09");
  const fresh = buildSchedule(loan({ penaltyFrom: undefined }), [aug, { month: "September 2026", amount: 2500, date: D("2026-09-08") }, { month: "October 2026", amount: 2500, date: D("2026-10-08") }, { month: "November 2026", amount: 2500, date: D("2026-11-09") }], 3);
  const nov = fresh.schedule[3];
  check("a cycle due after the cutoff, paid in full a day late, carries 75 + 200", nov.penalty === 75 && nov.lateFee === 200 && balanceFrom(fresh.schedule) === 275, JSON.stringify([nov.penalty, nov.lateFee, balanceFrom(fresh.schedule)]));
}

// 9. Existing arrears, rule in force (today after the cutoff): paying the overdue amount shown must
//    not turn the penalty into a credit against next month's bill.
{
  const lg = (extra) => ({ id: 9, startDate: D("2026-07-20"), totalPayable: 10000, terms: 4, monthlyAmort: 2500, processingFee: 0, bank, dueDay: 8, loanName: "legacy", lateFee: 200, ...extra });   // default cutoff 2026-10-10
  const sepOnTime = { month: "September 2026", amount: 2500, date: D("2026-09-08") };
  setToday("2026-10-12");
  const before = buildSchedule(lg(), [aug, sepOnTime], 3), nb0 = nextBillFrom(before);
  check("October (due 10/08) still unpaid on 10/12: overdue shown = 2,500 + 75 + 200", before.schedule[2].penalty === 75 && before.schedule[2].lateFee === 200 && nb0.overdueSeparate === 2775, JSON.stringify([before.schedule[2].penalty, nb0.overdueSeparate]));
  const paid = buildSchedule(lg(), [aug, sepOnTime, { month: "October 2026", amount: 2775, date: D("2026-10-12") }], 3), nb1 = nextBillFrom(paid);
  check("paying exactly that overdue clears it: nothing left over, November is just 2,500", nb1.overdueSeparate === 0 && nb1.bill === 2500, JSON.stringify([nb1.overdueSeparate, nb1.bill]));
  check("...no credit anywhere in the schedule", paid.schedule.every((r) => r.carryOut >= 0), JSON.stringify(paid.schedule.map((r) => r.carryOut)));
  check("balance after = the November instalment only (2,500)", balanceFrom(paid.schedule) === 2500, String(balanceFrom(paid.schedule)));
  const onlyBill = buildSchedule(lg(), [aug, sepOnTime, { month: "October 2026", amount: 2500, date: D("2026-10-12") }], 3), nb2 = nextBillFrom(onlyBill);
  check("paying only the 2,500 leaves the 275 penalty + fee still owed, not hidden in the instalment", nb2.overdueSeparate === 275, String(nb2.overdueSeparate));
  // history before the rule is left alone
  const settled = buildSchedule(lg(), [aug, { month: "September 2026", amount: 2500, date: D("2026-09-10") }, { month: "October 2026", amount: 2500, date: D("2026-10-08") }], 3);
  check("a cycle already paid (late) before the rule started keeps no penalty", settled.schedule[1].penalty === 0 && settled.schedule[1].lateFee === 200, JSON.stringify([settled.schedule[1].penalty, settled.schedule[1].lateFee]));
}

console.log(failures ? failures + " failed" : "all passed");
process.exit(failures ? 1 : 0);
