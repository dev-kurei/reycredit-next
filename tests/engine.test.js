const { buildSchedule, balanceFrom, statusFrom, nextBillFrom, liveLoanFigures, scoreBorrower, lendingGuide, remainingFrom } = require('../lib/engine.js');

function loan(o) { return Object.assign({ bank: { statementDay: 25, dueDay: 8, sameMonth: false } }, o); }

console.log("=== Regression: John A. (overpayment settles a prior shortfall) ===");
{
  const l = loan({ startDate: new Date(2026,3,29), totalPayable: 16011, terms: 6, monthlyAmort: 2618.50, processingFee: 300,
    bank: { statementDay: 25, dueDay: 8, sameMonth: false } });
  const pays = [
    { month: "June 2026", amount: 2695, date: new Date(2026,5,8) },
    { month: "July 2026", amount: 2668.50, date: new Date(2026,6,10) },
    { month: "August 2026", amount: 2968, date: new Date(2026,7,7) },
    { month: "September 2026", amount: 7679.50, date: new Date(2026,7,10) },
    { month: "November 2026", amount: 12.12, date: new Date(2026,8,18) },
  ];
  const f = liveLoanFigures(l, pays, 3);
  console.log("  balance:", f.balance, "(expect 0)");
  console.log("  next bill:", f.next, "(expect null)");
  console.log("  status:", f.statusText);
}

console.log("\n=== Regression: Venah P. (terms mismatch must not go negative) ===");
{
  const l = loan({ startDate: new Date(2026,1,20), totalPayable: 14083.53, terms: 6, monthlyAmort: 13183.53, processingFee: 900,
    bank: { statementDay: 1, dueDay: 24, sameMonth: true } });
  const pays = [
    { month: "March 2026", amount: 4500, date: new Date(2026,1,28) },
    { month: "April 2026", amount: 1095, date: new Date(2026,3,1) },
    { month: "May 2026", amount: 2347.25, date: new Date(2026,4,3) },
    { month: "May 2026", amount: 6141.28, date: new Date(2026,4,13) },
  ];
  const built = buildSchedule(l, pays, 3);
  console.log("  termsMismatch flagged:", built.termsMismatch, "(expect true)");
  console.log("  impliedAmort:", built.impliedAmort, "(expect 2197.26)");
  console.log("  no negative bill:", built.schedule.every(r => r.bill >= 0));

  l.monthlyAmort = 2197.26;
  const f = liveLoanFigures(l, pays, 3);
  console.log("  corrected balance:", f.balance, "(expect 0)  status:", f.statusText);
}

console.log("\n=== Regression: Glenn (2 consecutive shortfalls -> Delinquent) ===");
{
  const l = loan({ startDate: new Date(2026,1,10), totalPayable: 88084, terms: 12, monthlyAmort: 7298.67, processingFee: 500 });
  const pays = [
    { month: "March 2026", amount: 7299, date: new Date(2026,2,8) },
    { month: "April 2026", amount: 7814, date: new Date(2026,3,8) },
    { month: "May 2026", amount: 6995, date: new Date(2026,4,8) },
  ];
  const f = liveLoanFigures(l, pays, 3);
  console.log("  status:", f.statusText, "arrears:", f.arrears);
}

console.log("\n=== Credit score: multi-loan, mixed amounts (must weigh by money) ===");
{
  const big = loan({ startDate: new Date(2025,7,1), totalPayable: 120000, terms: 12, monthlyAmort: 10000, processingFee: 0, id: "big" });
  const small = loan({ startDate: new Date(2025,7,1), totalPayable: 6000, terms: 12, monthlyAmort: 500, processingFee: 0, id: "small" });
  const payMap = new Map();
  function seq(startY,startM,n){const out=[];for(let i=0;i<n;i++){const d=new Date(startY,startM+i,1);out.push(d);}return out;}
  const M=["January","February","March","April","May","June","July","August","September","October","November","December"];
  const dates = seq(2025,8,12);
  payMap.set("big", dates.map((d,i)=>({month:`${M[d.getMonth()]} ${d.getFullYear()}`, amount:10000, date:d})));
  payMap.set("small", []);
  const sc = scoreBorrower([big, small], payMap, 3);
  console.log("  score (big paid perfectly, small never paid):", sc.score, sc.grade, "(expect meaningfully > 50, weighted toward the big loan)");
}

console.log("\n=== Lending guide: adding an unbilled loan must not inflate standing ===");
{
  const existing = loan({ id:"e1", startDate: new Date(2026,0,10), totalPayable: 24000, terms: 12, monthlyAmort: 2000, processingFee: 0 });
  const pays = [];
  for (let i=0;i<9;i++) pays.push({month:`${["Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct"][i]} 2026`, amount:2000, date:new Date(2026,1+i,8)});
  const map = new Map([["e1", pays]]);
  const before = lendingGuide([existing], map, 3);
  const future = loan({ id:"e2", startDate: new Date(2026,8,20), totalPayable: 96000, terms: 12, monthlyAmort: 8000, processingFee:0 });
  const map2 = new Map([["e1", pays], ["e2", []]]);
  const after = lendingGuide([existing, future], map2, 3);
  console.log("  arrears before:", before.arrears, "after adding unbilled loan:", after.arrears, "(must be equal)");
}
