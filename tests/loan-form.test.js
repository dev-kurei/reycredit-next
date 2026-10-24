/**
 * The loan form and the engine must agree on what "monthly amortization" means.
 *
 * Engine: total payable = monthly amort x terms + processing fee (the fee is billed
 * once, on the first cycle, on top of the monthly amort).
 *
 * The form's previewLoan() once divided the fee-inclusive total by the terms, so every
 * loan created or edited through the app with a fee came out with the fee counted twice
 * (P9,512.10 + P1,000 fee, 1 month: the screen showed an amort of P10,512.10 and billed
 * P11,512.10). This test loads the REAL previewLoan out of public/index.html and checks
 * it against the REAL engine, so the two cannot drift apart again.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { buildSchedule, round2 } = require("../lib/engine");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const from = html.indexOf("function bankMonthlyFromRate(");
const to = html.indexOf("function fillBankSelects()");
if (from < 0 || to < 0 || to < from) throw new Error("Could not locate readLoanForm/previewLoan in public/index.html");

/** Runs the page's own previewLoan against a stubbed form. */
function formPreview({ principal, rate, terms, fee }) {
  const values = { "t-principal": principal, "t-rate": rate, "t-terms": terms, "t-fee": fee, "t-start": "2026-10-05", "t-dueday": 10, "t-bank": "", "t-loanname": "x", "t-loantype": "Cash Loan" };
  const sandbox = {
    $: (id) => ({ value: values[id] === undefined ? "" : String(values[id]), textContent: "" }),
    money: (n) => n, parseFloat, parseInt,
  };
  vm.createContext(sandbox);
  vm.runInContext(html.slice(from, to), sandbox);
  return sandbox.previewLoan("t");
}

/** What the engine makes of a loan saved with these figures. */
function engineView(v, f, amortOverride) {
  const amort = amortOverride === undefined ? v.amort : amortOverride;
  return buildSchedule(
    { id: 1, startDate: new Date("2026-10-05"), totalPayable: round2(v.total), terms: f.terms,
      monthlyAmort: amort, processingFee: f.fee, bank: null, dueDay: 10, loanName: "t" },
    [], 3);
}

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond || !detail ? "" : "  -> " + detail));
  if (!cond) failures++;
}

// 1. The exact loan from the bug report.
{
  const f = { principal: 9512.1, rate: 0, terms: 1, fee: 1000 };
  const v = formPreview(f);
  check("reported loan: amort is P9,512.10 (fee kept out of it)", round2(v.amort) === 9512.1, "got " + v.amort);
  check("reported loan: total payable is P10,512.10", round2(v.total) === 10512.1, "got " + v.total);
  const b = engineView(v, f);
  check("reported loan: engine sees no terms mismatch", b.termsMismatch === false);
  check("reported loan: engine expects exactly the total payable", round2(b.expectedPayable) === round2(b.statedPayable), b.expectedPayable + " vs " + b.statedPayable);
}

// 2. A grid of realistic loans: with and without a fee, with and without interest, 1..36 terms.
{
  let n = 0, bad = [];
  for (const principal of [500, 9512.1, 15000, 100000])
    for (const rate of [0, 0.59, 0.79, 3])
      for (const terms of [1, 3, 6, 12, 36])
        for (const fee of [0, 100, 300, 1000]) {
          const f = { principal, rate, terms, fee };
          const v = formPreview(f);
          // Both as typed and as a Postgres numeric(.,2) column would store it.
          for (const amort of [v.amort, round2(v.amort)]) {
            n++;
            const b = engineView(v, f, amort);
            if (b.termsMismatch || Math.abs(b.expectedPayable - b.statedPayable) > terms) bad.push(JSON.stringify(f) + " amort=" + amort);
          }
        }
  check("form + engine agree across " + n + " combinations", bad.length === 0, bad.slice(0, 3).join("; "));
}

// 3. This test has to be able to fail: the old formula (fee inside the amort) must be caught.
{
  const f = { principal: 9512.1, rate: 0, terms: 1, fee: 1000 };
  const v = formPreview(f);
  const oldAmort = v.total / f.terms;
  const b = engineView(v, f, oldAmort);
  check("sanity: the OLD formula is flagged as a mismatch by the engine", b.termsMismatch === true);
}

console.log(failures ? "\nFAILED: " + failures : "\nALL PASS");
process.exit(failures ? 1 : 0);
