/** The loan page and the Reports page both show where payments went, from the real database layer. */
const Module = require("module");
const { makeFakeDb } = require("./fake-supabase.js");
const RealDate = Date;
const fixed = new RealDate("2026-10-15T04:00:00Z").getTime();
global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };

const t = {
  borrowers: [{ id: 1, name: "Ally", email: "ally@x.com" }, { id: 2, name: "Ben", email: "ben@x.com" }],
  banks: [{ id: 1, name: "BPI", statement_day: 20, due_day: 8, due_month: "Next Month" }],
  loans: [
    { id: 1, borrower_id: 1, loan_name: "Cash", start_date: "2026-07-20", principal: 8000, terms: 4, monthly_rate: 5, processing_fee: 0, total_interest: 2000, total_payable: 10000, monthly_amort: 2500, bank_id: 1, due_day: 8, late_fee: 200, bank_monthly: 2300, bank_fee: 100, bank_terms: 4 },
    { id: 2, borrower_id: 2, loan_name: "On time", start_date: "2026-07-20", principal: 8000, terms: 4, monthly_rate: 5, processing_fee: 0, total_interest: 2000, total_payable: 10000, monthly_amort: 2500, bank_id: 1, due_day: 8, late_fee: 200 },
  ],
  payments: [
    { id: 1, loan_id: 1, for_month: "August 2026", amount: 2500, paid_date: "2026-08-08", receipt_no: "R1", method: "GCash" },
    { id: 2, loan_id: 1, for_month: "September 2026", amount: 2500, paid_date: "2026-09-08", receipt_no: "R2", method: "GCash" },
    { id: 3, loan_id: 1, for_month: "October 2026", amount: 2775, paid_date: "2026-10-12", receipt_no: "R3", method: "GCash" },
    { id: 4, loan_id: 2, for_month: "August 2026", amount: 2500, paid_date: "2026-08-08", receipt_no: "B1", method: "GCash" },
    { id: 5, loan_id: 2, for_month: "September 2026", amount: 2500, paid_date: "2026-09-08", receipt_no: "B2", method: "GCash" },
    { id: 6, loan_id: 2, for_month: "October 2026", amount: 2500, paid_date: "2026-10-08", receipt_no: "B3", method: "GCash" },
  ],
  users: [], email_log: [], config: [{ key: "PENALTY_RATE", value: "3" }],
};
const sent = [];
const fake = makeFakeDb(t); const load = Module._load;
Module._load = function (r) { if (r.endsWith("/supabase")) return { db: () => fake }; if (r.endsWith("/mailer")) return { sendMail: async (m) => { sent.push(m); return { success: true, id: "x" }; } }; return load.apply(this, arguments); };
const fns = require("../lib/functions.js");
let failures = 0;
const check = (label, cond, detail) => { console.log((cond ? "PASS " : "FAIL ") + label + (cond || !detail ? "" : "  -> " + detail)); if (!cond) failures++; };

(async () => {
  const d = await fns.getAdminBorrowerDetail(1);
  const m = d.money;
  check("loan page: 2,775 recorded, 275 of it penalty + late fee", d.amountPaid === 7775 && m.penaltiesPaid === 75 && m.lateFeesPaid === 200, JSON.stringify([d.amountPaid, m.penaltiesPaid, m.lateFeesPaid]));
  check("loan page: only 7,500 reduced the loan; 6,000 principal, 1,500 interest", m.instalmentsPaid === 7500 && m.principalPaid === 6000 && m.interestPaid === 1500, JSON.stringify(m));
  const h = d.history.find((x) => x.receiptNo === "R3");
  check("payment history shows the 2,775 split 2,500 / 275", h && h.toInstalments === 2500 && h.toCharges === 275, JSON.stringify(h));
  check("balance is the last instalment only (2,500), with no credit", d.balance === 2500, String(d.balance));

  const rc = await fns.sendPaymentReceipt(1, "October 2026", 2775, "10/12/2026", "R3", "GCash");
  const html = sent.length ? sent[sent.length - 1].html : "";
  check("receipt shows 2,500 to the loan and 275 to penalty & late fees", rc.success && /Applied to your loan/.test(html) && /2,500\.00/.test(html) && /Applied to penalty &amp; late fees/.test(html) && /275\.00/.test(html), rc.msg);
  const plain = await fns.sendPaymentReceipt(2, "October 2026", 2500, "10/08/2026", "B3", "GCash");
  check("an on-time payment's receipt has no split rows", plain.success && !/Applied to penalty/.test(sent[sent.length - 1].html));

  const r = await fns.getAdvancedReport();
  check("report succeeds with an income section", r.success && r.income, r.msg);
  const i = r.income;
  check("income: interest 1,500 + 1,500 = 3,000 from both loans", i.interest === 3000, String(i.interest));
  check("income: penalties 75 and late fees 200 collected, nothing unpaid", i.penaltiesPaid === 75 && i.lateFeesPaid === 200 && i.chargesPaid === 275 && i.chargesOwed === 0, JSON.stringify(i));
  const oct = i.byMonth[i.byMonth.length - 1];
  check("this month: 275 of charges collected, listed per month", oct.label === "Oct 26" && oct.charges === 275, JSON.stringify(oct));
  check("per-borrower list names the borrower who was charged", i.loans.some((x) => x.name === "Ally" && x.penaltiesPaid === 75 && x.lateFeesPaid === 200), JSON.stringify(i.loans));
  // ----- your profit after the bank (admin only) -----
  const pf = d.profit;
  check("loan 1: bank costs 2,300 x 4 + 100 = 9,300", pf.hasBankCost && pf.bankTotal === 9300, JSON.stringify(pf));
  check("...expected profit 10,000 - 9,300 = 700, margin 7%", pf.expectedProfit === 700 && pf.marginPct === 7, JSON.stringify([pf.expectedProfit, pf.marginPct]));
  check("...three bank bills are due by 10/15: paid 2,300 x 3 + 100 = 7,000; net cash 7,775 - 7,000 = 775", pf.bankPaid === 7000 && pf.netCash === 775, JSON.stringify([pf.bankPaid, pf.netCash]));
  check("...penalties and fees (275) are extra, and everything collected leaves 975", pf.extrasCollected === 275 && pf.projectedNet === 975 && pf.projectedNet === pf.expectedProfit + pf.extrasCollected, JSON.stringify([pf.extrasCollected, pf.projectedNet]));
  check("loan 1 itemised: interest income 2,000, your fee 0, bank interest 1,200, bank fee 100", pf.interestIncome === 2000 && pf.feeIncome === 0 && pf.bankInterest === 1200 && pf.bankFeeCharged === 100, JSON.stringify(pf));
  const d2 = await fns.getAdminBorrowerDetail(2);
  check("a loan with no bank cost entered says so instead of inventing a profit", d2.profit && d2.profit.hasBankCost === false);
  const rep = r.profit;
  check("report profit totals count only loans with a bank cost, and flags the other one", rep.loans === 1 && rep.missing === 1 && rep.expected === 700 && rep.netCash === 775 && rep.extras === 275 && rep.interestIncome === 2000 && rep.bankInterest === 1200 && rep.bankFees === 100, JSON.stringify(rep));
  const mine = await fns.getBorrowerData("ally@x.com");
  const wire = JSON.stringify(mine);
  check("what a borrower is sent has no profit, bank cost or bank payment anywhere", !/profit|bankMonthly|bankFee|bankTerms|bank_monthly|2300|9300/.test(wire), wire.slice(0, 200));
  const ad = await fns.addLoanToExistingBorrower({ email: "ally@x.com", loanName: "New", loanType: "Cash Loan", principal: 5000, rate: 3, terms: 3, fee: 0, startDate: "2026-10-01", dueDay: 8, partner: "BPI", totalInterest: 450, totalPayable: 5450, monthlyAmort: 1816.67, lateFee: 0, bankMonthly: 1750, bankFee: 50, bankTerms: 3 });
  const nl = t.loans[t.loans.length - 1];
  check("adding a loan stores the bank cost", ad.success && Number(nl.bank_monthly) === 1750 && Number(nl.bank_fee) === 50 && Number(nl.bank_terms) === 3, JSON.stringify([ad.msg, nl]));

  // ----- existing loans: bank cost is added on its own, without re-saving the loan -----
  const strip = (r) => JSON.stringify({ ...r, bank_monthly: null, bank_fee: null, bank_terms: null });
  const before = strip(t.loans[1]), payBefore = JSON.stringify(t.payments);
  const sb = await fns.setBankCost(2, 2200, 0, 0);
  check("setBankCost on an existing loan succeeds and returns the refreshed detail with the profit", sb.success && sb.detail.profit.hasBankCost && sb.detail.profit.bankTotal === 8800, JSON.stringify(sb).slice(0, 200));
  check("...and changes nothing else about the loan (terms, totals, amortization, late fee)", strip(t.loans[1]) === before && Number(t.loans[1].bank_monthly) === 2200);
  check("...and no payment was touched", JSON.stringify(t.payments) === payBefore);
  const up = await fns.updateBorrower(1, { name: "Ally", email: "ally@x.com", contact: "", idNum: "", address: "", ccEmail: "", loanName: "Cash", loanType: "Cash Loan", principal: 8000, rate: 5, terms: 4, fee: 0, startDate: "2026-07-20", dueDay: 8, partner: "BPI", totalInterest: 2000, totalPayable: 10000, monthlyAmort: 2500, lateFee: 200, lateFeeFrom: "" });
  check("editing a loan from a form with no bank fields keeps the saved bank cost", up.success && Number(t.loans[0].bank_monthly) === 2300 && Number(t.loans[0].bank_fee) === 100 && Number(t.loans[0].bank_terms) === 4, JSON.stringify([up.msg, t.loans[0].bank_monthly]));
  const rm = await fns.setBankCost(2, 0, 0, 0);
  check("entering zeros removes the bank cost", rm.success && rm.detail.profit.hasBankCost === false);

  console.log(failures ? failures + " failed" : "all passed");
  process.exit(failures ? 1 : 0);
})();
