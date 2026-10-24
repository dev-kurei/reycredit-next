#!/usr/bin/env node
/**
 * One-time import: Google Sheets (exported as CSV) -> Supabase.
 *
 *   1. In your Google Sheet, for EACH tab: File -> Download -> Comma-separated values (.csv)
 *      Rename the files exactly:  Master_Database.csv  Payment_History.csv  Users.csv  Banks.csv  Config.csv
 *      and put them in one folder, e.g.  ./export
 *   2. Try it first, changes nothing:    node scripts/migrate-from-sheets.js --dir ./export --dry-run
 *   3. Then for real:                    node --env-file=.env.local scripts/migrate-from-sheets.js --dir ./export
 *
 * It refuses to write into a database that already has loans in it, so running it twice
 * cannot duplicate anything.
 */
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const args = process.argv.slice(2);
const dir = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : "./export";
const DRY = args.includes("--dry-run");

/* ---------- tiny CSV parser (quotes, commas and newlines inside quotes) ---------- */
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell); if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}
function readTab(name, required) {
  const f = path.join(dir, name + ".csv");
  if (!fs.existsSync(f)) { if (required) { console.error(`Missing ${f}`); process.exit(1); } return []; }
  return parseCsv(fs.readFileSync(f, "utf8")).slice(1);   // drop header
}

/* ---------- value parsers ---------- */
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
function parseDate(v) {
  const s = String(v || "").trim(); if (!s) return null;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);            // MM/dd/yyyy (how the sheet displays it)
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const d = new Date(s); return isNaN(d.getTime()) ? null : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}
const iso = (d) => d.toISOString().slice(0, 10);
function monthLabelDate(label) {
  const p = String(label || "").trim().toLowerCase().split(/\s+/);
  const mi = MONTHS.indexOf(p[0]), y = parseInt(p[1], 10);
  return mi >= 0 && y ? new Date(Date.UTC(y, mi, 8)) : null;
}
const lc = (e) => String(e || "").trim().toLowerCase();

async function main() {
  const master = readTab("Master_Database", true).filter((r) => r[0] && r[1]);
  const history = readTab("Payment_History", true).filter((r) => r[0]);
  const users = readTab("Users", false).filter((r) => r[0]);
  const banks = readTab("Banks", false).filter((r) => r[0]);
  const config = readTab("Config", false).filter((r) => r[0]);

  const warn = [];

  /* ---------- banks ---------- */
  const bankRows = banks.map((r) => ({
    name: r[0].trim(), statement_day: Math.round(num(r[1])) || 1, due_day: Math.round(num(r[2])) || 1,
    due_month: /same/i.test(r[3] || "") ? "Same Month" : "Next Month",
  }));

  /* ---------- borrowers (one per email) ---------- */
  const borrowers = new Map();
  for (const r of master) {
    const e = lc(r[1]);
    const b = borrowers.get(e) || { name: r[0].trim(), email: e, contact: "", address: "", valid_id: "", cc_email: "" };
    b.contact ||= r[22] || ""; b.address ||= r[20] || ""; b.valid_id ||= r[21] || ""; b.cc_email ||= r[23] || "";
    borrowers.set(e, b);
  }

  /* ---------- loans (name must be unique per borrower) ---------- */
  const loans = []; const seen = new Map(); const nameMap = new Map();   // "email|orig" -> final name
  for (const r of master) {
    const e = lc(r[1]); const orig = String(r[2] || "").trim() || "Loan";
    let final = orig, k = 1;
    while (seen.has(e + "|" + final)) { k++; final = `${orig} (${k})`; }
    if (final !== orig) warn.push(`Duplicate loan name for ${e}: "${orig}" renamed "${final}". Its payments were all recorded under the first "${orig}" and stay there — review them.`);
    seen.set(e + "|" + final, true);
    if (!nameMap.has(e + "|" + orig)) nameMap.set(e + "|" + orig, final);
    const start = parseDate(r[3]);
    if (!start) { warn.push(`Skipped ${r[0]} / ${orig}: no readable start date ("${r[3]}").`); continue; }
    loans.push({
      _email: e, loan_name: final, loan_type: /cash/i.test(orig) ? "Cash Loan" : "Item Loan", start_date: iso(start),
      total_payable: num(r[4]), principal: num(r[5]), terms: Math.round(num(r[6])), monthly_rate: num(r[7]),
      total_interest: num(r[9]), processing_fee: num(r[10]), monthly_amort: num(r[13]),
      _bank: String(r[16] || "").trim(), due_day: Math.round(num(r[17])) || 1,
    });
  }

  /* ---------- payments ---------- */
  const loanKey = new Set(loans.map((l) => l._email + "|" + l.loan_name));
  const payments = []; let undated = 0, orphans = 0;
  for (const r of history) {
    const e = lc(r[0]); const orig = String(r[1] || "").trim();
    const final = nameMap.get(e + "|" + orig);
    if (!final || !loanKey.has(e + "|" + final)) { orphans++; warn.push(`Payment for "${orig}" (${e}) matches no loan — skipped.`); continue; }
    let d = parseDate(r[4]);
    if (!d) { d = monthLabelDate(r[2]); undated++; }
    if (!d) { warn.push(`Payment for ${orig} has no date or month — skipped.`); orphans++; continue; }
    payments.push({ _email: e, _loan: final, for_month: String(r[2] || "").trim(), amount: num(r[3]), paid_date: iso(d), receipt_no: String(r[5] || "").trim(), method: String(r[6] || "").trim() || "Cash" });
  }

  /* ---------- logins: hash the old plaintext passwords ---------- */
  const userRows = new Map();
  for (const r of users) {
    const e = lc(r[0]); if (!e) continue;
    userRows.set(e, { email: e, password_hash: bcrypt.hashSync(String(r[1] || "1234").trim() || "1234", 10), role: /admin/i.test(r[2] || "") ? "ADMIN" : "BORROWER" });
  }
  for (const e of borrowers.keys()) if (!userRows.has(e)) userRows.set(e, { email: e, password_hash: bcrypt.hashSync("1234", 10), role: "BORROWER" });

  /* ---------- data health: the mistake we found in the live sheet ---------- */
  const badAmort = loans.filter((l) => l.terms && Math.abs(l.total_payable - (l.monthly_amort * l.terms + l.processing_fee)) > l.terms);

  console.log(`\nFound: ${borrowers.size} borrowers \u00b7 ${loans.length} loans \u00b7 ${payments.length} payments \u00b7 ${userRows.size} logins \u00b7 ${bankRows.length} banks`);
  console.log(`Payments with no date (filled with the 8th of their billing month): ${undated}`);
  console.log(`Payments skipped: ${orphans}`);
  console.log(`Loans whose monthly amortization does not add up: ${badAmort.length}` + (badAmort.length ? "  -> fix them in Settings > Data health after importing" : ""));
  badAmort.slice(0, 20).forEach((l) => console.log(`   ${l._email} / ${l.loan_name}: stored ${l.monthly_amort}, should be ${((l.total_payable - l.processing_fee) / l.terms).toFixed(2)}`));
  if (warn.length) { console.log(`\n${warn.length} warning(s):`); warn.slice(0, 30).forEach((w) => console.log("  - " + w)); }

  if (DRY) { console.log("\nDRY RUN — nothing was written."); return; }

  /* ---------- write ---------- */
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) { console.error("\nSet SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (use --env-file=.env.local)."); process.exit(1); }
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const must = (r, what) => { if (r.error) { console.error(`\nFailed at ${what}: ${r.error.message}`); process.exit(1); } return r.data; };

  const { count } = await sb.from("loans").select("id", { count: "exact", head: true });
  if (count > 0) { console.error(`\nThe database already has ${count} loan(s). Refusing to import on top of it.`); process.exit(1); }

  if (bankRows.length) must(await sb.from("banks").upsert(bankRows, { onConflict: "name" }), "banks");
  const bankIds = new Map(must(await sb.from("banks").select("id,name"), "reading banks").map((b) => [b.name.toLowerCase(), b.id]));

  const bRows = must(await sb.from("borrowers").insert([...borrowers.values()]).select("id,email"), "borrowers");
  const borrowerId = new Map(bRows.map((b) => [b.email, b.id]));

  const loanRows = loans.map((l) => {
    const { _email, _bank, ...rest } = l;
    return { ...rest, borrower_id: borrowerId.get(_email), bank_id: bankIds.get(_bank.toLowerCase()) || null };
  });
  const insertedLoans = must(await sb.from("loans").insert(loanRows).select("id,borrower_id,loan_name"), "loans");
  const emailById = new Map(bRows.map((b) => [b.id, b.email]));
  const loanId = new Map(insertedLoans.map((l) => [emailById.get(l.borrower_id) + "|" + l.loan_name, l.id]));

  const payRows = payments.map((p) => { const { _email, _loan, ...rest } = p; return { ...rest, loan_id: loanId.get(_email + "|" + _loan) }; });
  for (let i = 0; i < payRows.length; i += 500) must(await sb.from("payments").insert(payRows.slice(i, i + 500)), "payments");

  must(await sb.from("users").upsert([...userRows.values()], { onConflict: "email" }), "users");
  if (config.length) must(await sb.from("config").upsert(config.map((r) => ({ key: String(r[0]).trim(), value: String(r[1] ?? "") })), { onConflict: "key" }), "config");

  console.log("\nDONE. Imported everything. Now open the app > Settings > Data health > Run check.");
}
main().catch((e) => { console.error(e); process.exit(1); });
