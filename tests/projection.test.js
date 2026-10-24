// Projected cash flow must come from each loan's own remaining bills, not one flat number.
const Module = require("module"); const { makeFakeDb } = require("./fake-supabase.js");
const t = { borrowers:[{id:1,name:"A",email:"a@x.com"},{id:2,name:"B",email:"b@x.com"}],
  banks:[{id:1,name:"BPI",statement_day:25,due_day:8,due_month:"Next Month"}],
  loans:[
    {id:1,borrower_id:1,loan_name:"Long",start_date:"2026-09-01",principal:12000,terms:12,monthly_rate:0,processing_fee:0,total_interest:0,total_payable:12000,monthly_amort:1000,bank_id:1,due_day:8},
    {id:2,borrower_id:2,loan_name:"Short",start_date:"2026-09-01",principal:2000,terms:2,monthly_rate:0,processing_fee:0,total_interest:0,total_payable:2000,monthly_amort:1000,bank_id:1,due_day:8}],
  payments:[], users:[], email_log:[], config:[{key:"PENALTY_RATE",value:"3"}] };
const fake = makeFakeDb(t); const load = Module._load;
Module._load = function(r){ if (r.endsWith("/supabase")) return { db:()=>fake }; if (r.endsWith("/mailer")) return { sendMail: async()=>({success:true}) }; return load.apply(this, arguments); };
require("../lib/functions.js").getAdvancedReport().then(r => {
  const p = r.projected.map(x => x.label + ": " + x.expected + " (" + x.borrowers + " loans)");
  console.log(p.join("\n"));
  const flat = new Set(r.projected.map(x => x.expected)).size === 1;
  console.log(flat ? "FAIL: months are identical" : "PASS: months differ as the loans wind down");
});
