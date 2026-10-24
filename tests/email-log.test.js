/** The Email log keeps what was sent so the app can show it, without ever breaking a send. */
const Module = require("module");
const { makeFakeDb } = require("./fake-supabase.js");
const bcrypt = require("bcryptjs");

const tables = {
  borrowers: [{ id: 1, name: "John A.", email: "j@x.com", contact: "", address: "", valid_id: "", cc_email: "" }],
  banks: [],
  loans: [{ id: 10, borrower_id: 1, loan_name: "Cash", loan_type: "Cash Loan", start_date: "2026-10-05", principal: 1000, terms: 1,
    monthly_rate: 0, processing_fee: 0, total_interest: 0, total_payable: 1000, monthly_amort: 1000, bank_id: null, due_day: 10, closed: false }],
  payments: [], users: [{ id: 1, email: "j@x.com", password_hash: bcrypt.hashSync("1234", 4), role: "BORROWER" }],
  email_log: [], config: [{ key: "PENALTY_RATE", value: "3" }],
};
const fakeDb = makeFakeDb(tables);

// Simulates a database where email-log-body.sql has NOT been run yet.
let columnsMissing = false;
const db = {
  from(name) {
    const b = fakeDb.from(name);
    if (name !== "email_log") return b;
    const insert = b.insert.bind(b);
    b.insert = (p) => {
      if (columnsMissing && ("body_html" in p || "attachment_names" in p))
        return Promise.resolve({ data: null, error: { message: 'Could not find the "body_html" column of "email_log"' } });
      return insert(p);
    };
    return b;
  },
};

const orig = Module._load;
Module._load = function (request) {
  if (request.endsWith("/supabase") || request === "./supabase") return { db: () => db };
  if (request.endsWith("/mailer") || request === "./mailer") return { sendMail: async () => ({ success: true, id: "rs_1" }) };
  return orig.apply(this, arguments);
};
const fns = require("../lib/functions.js");

let failures = 0;
const check = (label, cond, detail) => { console.log((cond ? "PASS " : "FAIL ") + label + (cond || !detail ? "" : "  -> " + detail)); if (!cond) failures++; };

(async () => {
  await fns.sendDueDateReminder(10);
  let list = await fns.getEmailLog(50);
  check("reminder is logged", list.success && list.entries.length === 1 && list.entries[0].type === "reminder");
  check("the list does not carry the body", list.entries[0].html === undefined && list.entries[0].body_html === undefined);

  const one = await fns.getEmailLogEntry(list.entries[0].id);
  check("entry returns the saved email HTML", one.success && one.entry.bodyStored && /<html|<table|<div/i.test(one.entry.html), JSON.stringify(one).slice(0, 120));
  check("entry keeps its recipient + subject", one.entry.to === "j@x.com" && !!one.entry.subject);

  const missing = await fns.getEmailLogEntry(9999);
  check("unknown id is a clean failure", missing.success === false);

  // A password reset email carries the new PIN: it must never be stored.
  await fns.resetPasswordToDefault("j@x.com");
  const reset = tables.email_log.find((r) => r.email_type === "reset_pin");
  check("reset email is logged", !!reset);
  check("reset email body is NOT stored (it holds the PIN)", reset && !reset.body_html);
  const resetEntry = await fns.getEmailLogEntry(reset.id);
  check("reset entry says it was skipped on purpose", resetEntry.entry.bodySkipped === true && resetEntry.entry.bodyStored === false);

  // Before the SQL has been run, sends must still be logged (metadata only).
  columnsMissing = true;
  const before = tables.email_log.length;
  await fns.sendDueDateReminder(10);
  check("send is still logged when the body columns don't exist yet", tables.email_log.length === before + 1);
  const legacy = tables.email_log[tables.email_log.length - 1];
  check("...as metadata only", !legacy.body_html);
  const legacyEntry = await fns.getEmailLogEntry(legacy.id);
  check("...and shows 'content not saved' rather than failing", legacyEntry.success && legacyEntry.entry.bodyStored === false && legacyEntry.entry.bodySkipped === false);

  console.log(failures ? "\nFAILED: " + failures : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
