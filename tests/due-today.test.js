/**
 * A cycle that falls due TODAY is not "past" until tomorrow. A payment already made toward it
 * (here P1,000 of a P1,060.15 carry-over) must still reduce what is shown as overdue, and the row
 * must not claim "cleared" while money is still owed. Reported on Meliza A. Tambong / Honor x5C.
 */
const { buildSchedule, balanceFrom, owedToday, statusFrom, round2 } = require("../lib/engine");

const RealDate = Date;
function setToday(iso) {   // 04:00 UTC = noon in Manila, same calendar day
  const fixed = new RealDate(iso + "T04:00:00Z").getTime();
  global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
}

const loan = { id: 1, startDate: new RealDate("2026-06-08"), totalPayable: 6999, terms: 3, monthlyAmort: 2333, processingFee: 0, bank: null, dueDay: 8, loanName: "Honor x5C" };
const pays = [
  { month: "July 2026", amount: 2000, date: new RealDate("2026-07-20") },
  { month: "August 2026", amount: 2000, date: new RealDate("2026-08-11") },
  { month: "September 2026", amount: 2000, date: new RealDate("2026-08-26") },
  { month: "October 2026", amount: 1000, date: new RealDate("2026-09-14") },
];

let failures = 0;
const check = (label, cond, detail) => { console.log((cond ? "PASS " : "FAIL ") + label + (cond || !detail ? "" : "  -> " + detail)); if (!cond) failures++; };

// The day it is due (the reported screenshot).
setToday("2026-10-08");
let b = buildSchedule(loan, pays, 3);
const oct = b.schedule[b.schedule.length - 1];
check("October is the cycle due today", oct.dueDate === "10/08/2026" && oct.isPast === false, oct.dueDate + " past=" + oct.isPast);
check("true balance is P60.15", balanceFrom(b.schedule) === 60.15, String(balanceFrom(b.schedule)));
check("overdue today is P60.15, not P1,060.15", owedToday(b.schedule) === 60.15, String(owedToday(b.schedule)));
check("that row still has P60.15 outstanding (so it must not read 'cleared')", oct.outstanding === 60.15, String(oct.outstanding));
check("overdue + paid-so-far equals charges to date", round2(owedToday(b.schedule) + 7000) === round2(7000 + 60.15));

// The next day: October is past, the penalty applies, and the figures still agree.
setToday("2026-10-09");
b = buildSchedule(loan, pays, 3);
const owed2 = owedToday(b.schedule);
check("next day overdue is P60.15 + 3% penalty = P61.95", owed2 === 61.95, String(owed2));
check("next day balance matches the schedule (P61.95)", balanceFrom(b.schedule) === 61.95, String(balanceFrom(b.schedule)));

// Fully paid ahead of the due date: nothing overdue.
setToday("2026-10-08");
b = buildSchedule(loan, pays.slice(0, 3).concat([{ month: "October 2026", amount: 1060.15, date: new RealDate("2026-09-14") }]), 3);
check("paying the whole carry-over clears the overdue figure", owedToday(b.schedule) === 0, String(owedToday(b.schedule)));
check("...and the status is no longer delinquent", statusFrom(balanceFrom(b.schedule), b) !== "DELINQUENT", statusFrom(balanceFrom(b.schedule), b));

// Unpaid carry-over on its due date is still fully overdue (the fix must not hide real arrears).
b = buildSchedule(loan, pays.slice(0, 3), 3);
check("with nothing paid toward it, the full carry-over stays overdue", owedToday(b.schedule) === 1060.15, String(owedToday(b.schedule)));

global.Date = RealDate;
console.log(failures ? "\nFAILED: " + failures : "\nALL PASS");
process.exit(failures ? 1 : 0);
