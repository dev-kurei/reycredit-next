/**
 * Flat late payment fee (per loan) and the "overdue stays on its own line until the statement
 * date" rule. Uses the real engine with a pinned calendar.
 */
const { buildSchedule, balanceFrom, owedToday, nextBillFrom, round2 } = require("../lib/engine");

const RealDate = Date;
function setToday(iso) {   // 04:00 UTC = noon in Manila, the same calendar day
  const fixed = new RealDate(iso + "T04:00:00Z").getTime();
  global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
}
const D = (s) => new RealDate(s);
let failures = 0;
const check = (label, cond, detail) => { console.log((cond ? "PASS " : "FAIL ") + label + (cond || !detail ? "" : "  -> " + detail)); if (!cond) failures++; };

const honor = (extra) => ({ id: 1, startDate: D("2026-06-08"), totalPayable: 6999, terms: 3, monthlyAmort: 2333, processingFee: 0, bank: null, dueDay: 8, loanName: "Honor x5C", ...extra });
const honorPays = [
  { month: "July 2026", amount: 2000, date: D("2026-07-20") },
  { month: "August 2026", amount: 2000, date: D("2026-08-11") },
  { month: "September 2026", amount: 2000, date: D("2026-08-26") },
  { month: "October 2026", amount: 1000, date: D("2026-09-14") },
];

setToday("2026-10-09");

// 1. Off by default: nothing changes for a loan with no late fee.
{
  const b = buildSchedule(honor(), honorPays, 3);
  check("no late fee configured -> no late fee charged", b.schedule.every((r) => r.lateFee === 0));
  check("...and the balance is unchanged from before (P61.95)", balanceFrom(b.schedule) === 61.95, String(balanceFrom(b.schedule)));
}

// 2. P200 per late cycle, hand-computed.
{
  const b = buildSchedule(honor({ lateFee: 200 }), honorPays, 3);
  const [jul, aug, sep, oct] = b.schedule;
  check("July: paid 07/20 after the 07/08 due date -> late, P200", jul.lateFee === 200 && jul.carryOut === 542.99, JSON.stringify([jul.lateFee, jul.carryOut]));
  check("August: carry-over + new bill, late again", aug.lateFee === 200 && aug.carryOut === 1102.27, JSON.stringify([aug.lateFee, aug.carryOut]));
  check("September: paid on time but not enough -> still late", sep.lateFee === 200 && sep.carryOut === 1678.33, JSON.stringify([sep.lateFee, sep.carryOut]));
  check("October (past term): still unsettled -> another P200", oct.lateFee === 200 && oct.carryOut === 898.68, JSON.stringify([oct.lateFee, oct.carryOut]));
  const bal = balanceFrom(b.schedule);
  check("balance = 6,999 + penalties 99.68 + 4 late fees 800 - 7,000 paid = P898.68", bal === 898.68, String(bal));
  check("overdue today agrees with the balance", owedToday(b.schedule) === 898.68, String(owedToday(b.schedule)));
}

// 3. A start date stops the fee being applied to cycles that fell due before it was agreed.
{
  const b = buildSchedule(honor({ lateFee: 200, lateFeeFrom: D("2026-09-01") }), honorPays, 3);
  const fees = b.schedule.slice(0, 4).map((r) => r.lateFee);   // the 5th row is the not-yet-due extension month
  check("late fee only from the agreed date (Sept and Oct only)", JSON.stringify(fees) === JSON.stringify([0, 0, 200, 200]), JSON.stringify(fees));
}

// 4. Settled late is still late; settled on the due date is not.
{
  setToday("2026-09-30");   // after the 09/08 due date, before the next cycle falls due
  const one = (payDate) => buildSchedule({ id: 2, startDate: D("2026-08-20"), totalPayable: 1000, terms: 1, monthlyAmort: 1000, processingFee: 0, bank: null, dueDay: 8, loanName: "x", lateFee: 150 },
    [{ month: "September 2026", amount: 1000, date: D(payDate) }], 3);
  const late = one("2026-09-12"), onDue = one("2026-09-08"), early = one("2026-09-01");
  check("paid in full but 4 days late -> fee charged", late.schedule[0].lateFee === 150, String(late.schedule[0].lateFee));
  check("...and the fee is owed afterwards (balance P150)", balanceFrom(late.schedule) === 150, String(balanceFrom(late.schedule)));
  check("paid in full ON the due date -> no fee", onDue.schedule[0].lateFee === 0 && balanceFrom(onDue.schedule) === 0);
  check("paid early -> no fee", early.schedule[0].lateFee === 0 && balanceFrom(early.schedule) === 0);
  setToday("2026-10-01");   // first cycle (10/08) is still ahead
  const future = buildSchedule({ id: 3, startDate: D("2026-09-20"), totalPayable: 1000, terms: 1, monthlyAmort: 1000, processingFee: 0, bank: null, dueDay: 8, loanName: "y", lateFee: 150 }, [], 3);
  check("a cycle not yet due is never charged", future.schedule[0].lateFee === 0);
}

setToday("2026-10-09");
// 5. Overdue stays on its own line until the bank's statement date.
{
  const bank = { statementDay: 25, dueDay: 8, sameMonth: false };
  const loan = { id: 4, startDate: D("2026-06-10"), totalPayable: 6000, terms: 6, monthlyAmort: 1000, processingFee: 0, bank, dueDay: 8, loanName: "Bank loan", lateFee: 100 };
  const pays = [{ month: "July 2026", amount: 600, date: D("2026-07-07") }];

  setToday("2026-10-09");
  let built = buildSchedule(loan, pays, 3);
  let nb = nextBillFrom(built);
  check("next cycle is November", nb.month === "November 2026" && nb.dueDate === "11/08/2026", nb.month + " " + nb.dueDate);
  check("before the statement date the overdue is a separate line", nb.overdueSeparate > 0 && nb.overdueSeparate === nb.overdueAmount, JSON.stringify(nb));
  check("...and 'Next payment' is only this cycle's P1,000", nb.bill === 1000, String(nb.bill));
  check("...total due still adds up", round2(nb.bill + nb.overdueSeparate) === nb.totalDue);
  check("...with the date it merges", nb.mergesOn === "October 25, 2026", nb.mergesOn);
  check("...and the breakdown reports what was charged on top", nb.lateFeesCharged > 0 && nb.penaltyCharged > 0, JSON.stringify([nb.lateFeesCharged, nb.penaltyCharged]));

  setToday("2026-10-24");
  nb = nextBillFrom(buildSchedule(loan, pays, 3));
  check("the day before the statement it is still separate", nb.overdueSeparate > 0);

  setToday("2026-10-25");
  nb = nextBillFrom(buildSchedule(loan, pays, 3));
  check("on the statement date the overdue is billed together", nb.overdueSeparate === 0 && nb.bill === nb.totalDue && nb.hasCarry === true, JSON.stringify(nb));

  // Paying the "Next payment" shown on screen clears it; the overdue line is untouched.
  setToday("2026-10-09");
  const before = nextBillFrom(buildSchedule(loan, pays, 3));
  const paidOwn = nextBillFrom(buildSchedule(loan, pays.concat([{ month: "November 2026", amount: 1000, date: D("2026-10-09") }]), 3));
  check("paying the next payment brings it to zero", paidOwn.bill === 0, String(paidOwn.bill));
  check("...and leaves the overdue line exactly as it was", paidOwn.overdueSeparate === before.overdueSeparate, paidOwn.overdueSeparate + " vs " + before.overdueSeparate);
  check("...total owed fell by exactly what was paid", round2(before.totalDue - paidOwn.totalDue) === 1000);
  const paidMore = nextBillFrom(buildSchedule(loan, pays.concat([{ month: "November 2026", amount: 1500, date: D("2026-10-09") }]), 3));
  check("paying more than the next payment reduces the overdue line", paidMore.bill === 0 && round2(before.overdueSeparate - paidMore.overdueSeparate) === 500, JSON.stringify([paidMore.bill, paidMore.overdueSeparate]));

  // The balance itself never depends on the display rule.
  setToday("2026-10-09"); const bal1 = balanceFrom(buildSchedule(loan, pays, 3).schedule);
  check("the display rule does not change the balance", bal1 === balanceFrom(buildSchedule(loan, pays, 3).schedule) && bal1 > 0);
}

// 6. A past-term loan has no new instalment to bill: its overdue is never hidden.
{
  setToday("2026-10-09");
  const nb = nextBillFrom(buildSchedule(honor({ lateFee: 200 }), honorPays, 3));
  check("past-term: overdue is not split off", nb.overdueSeparate === 0 && nb.bill === nb.totalDue && nb.bill > 0, JSON.stringify(nb));
}

global.Date = RealDate;
console.log(failures ? "\nFAILED: " + failures : "\nALL PASS");
process.exit(failures ? 1 : 0);
