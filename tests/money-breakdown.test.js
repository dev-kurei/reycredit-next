/**
 * Where a payment goes: charges already owed (penalty, then late fee) first, then the instalments.
 * Principal, interest and fees are the instalments split in proportion; charges never reduce them.
 */
const { buildSchedule, balanceFrom, moneyBreakdown, liveLoanFigures } = require("../lib/engine");

const RealDate = Date;
function setToday(iso) {
  const fixed = new RealDate(iso + "T04:00:00Z").getTime();
  global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
}
const D = (s) => new RealDate(s);
let failures = 0;
const check = (label, cond, detail) => { console.log((cond ? "PASS " : "FAIL ") + label + (cond || !detail ? "" : "  -> " + detail)); if (!cond) failures++; };

const bank = { statementDay: 20, dueDay: 8, sameMonth: false };
// 8,000 borrowed, 2,000 interest, no processing fee: 4 x 2,500
const loan = (x) => ({ id: 1, startDate: D("2026-07-20"), totalPayable: 10000, terms: 4, monthlyAmort: 2500, processingFee: 0, principal: 8000, totalInterest: 2000, bank, dueDay: 8, loanName: "t", lateFee: 200, penaltyFrom: null, ...x });
const aug = { month: "August 2026", amount: 2500, date: D("2026-08-08") };
const run = (iso, pays, x) => { setToday(iso); const l = loan(x); const b = buildSchedule(l, pays, 3); return { b, m: moneyBreakdown(l, b, pays), bal: balanceFrom(b.schedule) }; };

// 1. 2,500 bill, 275 penalty + fee, pays 2,775: recorded in full, loan reduced by 2,500 only.
{
  const { m, bal } = run("2026-09-15", [aug, { month: "September 2026", amount: 2775, date: D("2026-09-10"), receiptNo: "R2" }]);
  check("2,775 paid late: 275 goes to penalty (75) and late fee (200)", m.penaltiesPaid === 75 && m.lateFeesPaid === 200 && m.chargesPaid === 275, JSON.stringify([m.penaltiesPaid, m.lateFeesPaid]));
  check("...and the loan itself is reduced by 2,500 (two instalments paid = 5,000)", m.instalmentsPaid === 5000 && m.instalmentsLeft === 5000, JSON.stringify([m.instalmentsPaid, m.instalmentsLeft]));
  check("principal 4,000 and interest 1,000 collected from the 5,000 of instalments", m.principalPaid === 4000 && m.interestPaid === 1000, JSON.stringify([m.principalPaid, m.interestPaid]));
  check("the payment itself is split 275 / 2,500", m.applied[1].toCharges === 275 && m.applied[1].toInstalments === 2500, JSON.stringify(m.applied[1]));
  check("reconciles with the balance", m.instalmentsLeft + m.chargesOwed - m.overpaid === bal, JSON.stringify([m.instalmentsLeft, m.chargesOwed, bal]));
}

// 2. Nothing paid yet: charges are owed, not collected.
{
  const { m, bal } = run("2026-09-15", [aug]);
  check("charges owed 275, none collected", m.chargesOwed === 275 && m.chargesPaid === 0 && m.penaltiesCharged === 75 && m.lateFeesCharged === 200);
  check("reconciles: 7,500 of instalments + 275 owed", m.instalmentsLeft + m.chargesOwed === bal, JSON.stringify([m.instalmentsLeft, m.chargesOwed, bal]));
}

// 3. Paying only 2,500 late: the charges are taken first, so the instalment is 275 short, not the penalty.
{
  const { m, bal } = run("2026-09-15", [aug, { month: "September 2026", amount: 2500, date: D("2026-09-10") }]);
  check("2,500 paid late: charges collected first (275)", m.chargesPaid === 275 && m.chargesOwed === 0, JSON.stringify([m.chargesPaid, m.chargesOwed]));
  check("...so the instalments only go down by 2,225 and the loan is not shortened by penalty money", m.instalmentsPaid === 2500 + 2225, String(m.instalmentsPaid));
  check("reconciles", m.instalmentsLeft + m.chargesOwed === bal, JSON.stringify([m.instalmentsLeft, bal]));
}

// 4. Paid on the due date: nothing is charged, everything is instalment.
{
  const { m } = run("2026-09-15", [aug, { month: "September 2026", amount: 2500, date: D("2026-09-08") }]);
  check("on time: no charges, 5,000 of instalments", m.chargesPaid === 0 && m.penaltiesCharged === 0 && m.instalmentsPaid === 5000);
}

// 5. Processing fee, split of a first instalment.
{
  const l = { id: 2, startDate: D("2026-07-20"), totalPayable: 10300, terms: 4, monthlyAmort: 2500, processingFee: 300, principal: 8000, totalInterest: 2000, bank, dueDay: 8, loanName: "f", lateFee: 0, penaltyFrom: null };
  setToday("2026-08-20");
  const pays = [{ month: "August 2026", amount: 2800, date: D("2026-08-08") }];
  const b = buildSchedule(l, pays, 3), m = moneyBreakdown(l, b, pays);
  check("2,800 first payment: fee share + principal + interest add up to what was paid", Math.abs(m.feePaid + m.principalPaid + m.interestPaid - 2800) < 0.011, JSON.stringify([m.feePaid, m.principalPaid, m.interestPaid]));
  check("processing fee collected is pro rata (300 x 2,800 / 10,300)", Math.abs(m.feePaid - round(300 * 2800 / 10300)) < 0.02, String(m.feePaid));
}
function round(n) { return Math.round(n * 100) / 100; }

// 6. liveLoanFigures carries it, and an overpayment is shown, not lost.
{
  setToday("2026-09-15");
  const l = loan({});
  const f = liveLoanFigures(l, [aug, { month: "September 2026", amount: 2500, date: D("2026-09-01") }], 3);
  check("liveLoanFigures exposes the breakdown", f.money && f.money.instalmentsPaid === 5000);
  setToday("2026-11-15");
  const over = [aug, { month: "September 2026", amount: 2500, date: D("2026-09-08") }, { month: "October 2026", amount: 2500, date: D("2026-10-08") }, { month: "November 2026", amount: 3000, date: D("2026-11-08") }];
  const b = buildSchedule(l, over, 3), m = moneyBreakdown(l, b, over);
  check("paying more than the whole loan: the extra 500 is shown as overpaid", m.overpaid === 500 && m.instalmentsLeft === 0, JSON.stringify([m.overpaid, m.instalmentsLeft]));
}

// 7. Your processing fee and the bank's are kept apart.
{
  const { profitFrom } = require("../lib/engine");
  setToday("2026-09-15");
  const l = { id: 3, startDate: D("2026-07-20"), totalPayable: 10300, terms: 4, monthlyAmort: 2500, processingFee: 300, principal: 8000, totalInterest: 2000, bank, dueDay: 8, loanName: "p", lateFee: 0, penaltyFrom: null, bankMonthly: 2300, bankFee: 100, bankTerms: 4 };
  const pays = [{ month: "August 2026", amount: 2800, date: D("2026-08-08") }];
  const b = buildSchedule(l, pays, 3), m = moneyBreakdown(l, b, pays);
  const pf = profitFrom(l, b, m, balanceFrom(b.schedule), 2800);
  check("what you charge: interest 2,000 and your own processing fee 300, listed separately", pf.interestIncome === 2000 && pf.feeIncome === 300, JSON.stringify([pf.interestIncome, pf.feeIncome]));
  check("what the bank charges: interest 1,200 (9,200 paid less 8,000 borrowed) and its own fee 100, listed separately", pf.bankInterest === 1200 && pf.bankFeeCharged === 100, JSON.stringify([pf.bankInterest, pf.bankFeeCharged]));
  check("your interest patong = interest charged less the bank's interest = 800", pf.interestMarkup === 800 && pf.principal === 8000, JSON.stringify([pf.interestMarkup, pf.principal]));
  check("profit = patong 800 + your fee 300 - bank fee 100 = 1,000", pf.expectedProfit === pf.interestMarkup + pf.feeIncome - pf.bankFeeCharged);
  check("expected profit = 2,000 + 300 - 1,200 - 100 = 1,000", pf.expectedProfit === 1000 && pf.expectedProfit === pf.interestIncome + pf.feeIncome - pf.bankInterest - pf.bankFeeCharged, String(pf.expectedProfit));
}

// 8. The bank is on 12 months, the borrower on 9: the bank keeps billing after the borrower's last payment.
{
  const { profitFrom } = require("../lib/engine");
  const l = { id: 4, startDate: D("2026-01-20"), totalPayable: 9000, terms: 9, monthlyAmort: 1000, processingFee: 0, principal: 7200, totalInterest: 1800, bank, dueDay: 8, loanName: "q", lateFee: 0, penaltyFrom: null, bankMonthly: 700, bankFee: 0, bankTerms: 12 };
  // Borrower pays all 9 instalments on time (Feb..Oct 2026).
  const pays = []; for (let m = 0; m < 9; m++) pays.push({ month: ["February","March","April","May","June","July","August","September","October"][m] + " 2026", amount: 1000, date: D(new Date(2026, 1 + m, 8).toISOString().slice(0, 10)) });
  setToday("2026-10-15");      // 9 bank bills have fallen due (Feb..Oct), 3 to go
  let b = buildSchedule(l, pays, 3), m = moneyBreakdown(l, b, pays), pf = profitFrom(l, b, m, balanceFrom(b.schedule), 9000);
  check("bank total is 12 x 700 = 8,400 even though the borrower has 9 terms", pf.bankTotal === 8400 && pf.borrowerTerms === 9 && pf.bankMonthsAfterBorrower === 3, JSON.stringify([pf.bankTotal, pf.borrowerTerms, pf.bankMonthsAfterBorrower]));
  check("expected profit = 9,000 - 8,400 = 600; bank interest = 8,400 - 7,200 = 1,200", pf.expectedProfit === 600 && pf.bankInterest === 1200, JSON.stringify([pf.expectedProfit, pf.bankInterest]));
  check("9 bills paid so far (6,300); net cash 9,000 - 6,300 = 2,700", pf.bankPaid === 6300 && pf.netCash === 2700, JSON.stringify([pf.bankPaid, pf.netCash]));
  setToday("2026-12-15");      // borrower finished in October; the bank has billed Nov and Dec too
  b = buildSchedule(l, pays, 3); m = moneyBreakdown(l, b, pays); pf = profitFrom(l, b, m, balanceFrom(b.schedule), 9000);
  check("after the borrower's last payment the bank is still billed: 11 bills = 7,700, net cash drops to 1,300", pf.bankPaid === 7700 && pf.netCash === 1300 && pf.bankLeft === 700, JSON.stringify([pf.bankPaid, pf.netCash, pf.bankLeft]));
  setToday("2027-02-15");
  b = buildSchedule(l, pays, 3); m = moneyBreakdown(l, b, pays); pf = profitFrom(l, b, m, balanceFrom(b.schedule), 9000);
  check("once the bank is fully paid, net cash = the expected profit (600) and nothing is left to pay", pf.bankPaid === 8400 && pf.netCash === 600 && pf.bankLeft === 0, JSON.stringify([pf.bankPaid, pf.netCash, pf.bankLeft]));
}

console.log(failures ? failures + " failed" : "all passed");
process.exit(failures ? 1 : 0);
