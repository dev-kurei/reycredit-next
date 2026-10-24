/*  ============================================================
    Printable documents — Statement of Account, Loan Agreement.
    Same design tokens as the app and the emails. These render as a
    full HTML page with a "Print / Save as PDF" button — there is no
    server-side PDF renderer in this serverless deployment, so the
    browser's own print-to-PDF does the job, exactly as the download
    buttons elsewhere in the app already work.
    ============================================================ */
const { peso, fmtDate, lateClauseText, nextBillFrom } = require("./engine");
const LOGO_DATA_URI = require("./assets/logo-data-uri");
const SIGNATURE_DATA_URI = require("./assets/signature-data-uri");

const INK = "#0f172a", MUTED = "#64748b", LINE = "#e2e8f0", SURF = "#f8fafc";
const BRAND = "#2563eb", OK = "#16a34a", BAD = "#dc2626", WARN = "#b45309";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function css() {
  return `@page{size:letter;margin:0.5in 0.55in;} *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:${FONT};color:${INK};font-size:12px;line-height:1.6;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  table{border-collapse:collapse;width:100%;} .mono{font-family:ui-monospace,Menlo,monospace;} .muted{color:${MUTED};}
  .head{padding-bottom:16px;border-bottom:1px solid ${LINE};margin-bottom:22px;}
  .brand{font-size:16px;font-weight:600;letter-spacing:-0.3px;} .brand-sub{font-size:10px;color:${MUTED};margin-top:1px;}
  .doc-title{font-size:15px;font-weight:600;} .doc-ref{font-size:10px;color:${MUTED};margin-top:3px;font-family:ui-monospace,Menlo,monospace;}
  .who{border:1px solid ${LINE};border-radius:10px;padding:15px 18px;margin-bottom:16px;}
  .who-name{font-size:16px;font-weight:600;} .who-sub{font-size:11px;color:${MUTED};margin-top:2px;}
  .tile{border:1px solid ${LINE};border-radius:10px;padding:12px 14px;}
  .tile-l{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED};}
  .tile-v{font-size:15px;font-weight:700;margin-top:5px;}
  .bar-wrap{background:#e2e8f0;border-radius:99px;height:7px;margin-top:7px;} .bar{background:${BRAND};border-radius:99px;height:7px;}
  .sec{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:${MUTED};padding-bottom:7px;border-bottom:1px solid ${LINE};margin:0 0 11px;}
  .card{border:1px solid ${LINE};border-radius:10px;padding:14px 16px;}
  .kv td{padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:11.5px;} .kv tr:last-child td{border-bottom:none;}
  .kv td:first-child{color:${MUTED};} .kv td:last-child{text-align:right;font-weight:600;}
  .data th{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED};border-bottom:1px solid ${LINE};padding:8px 10px;text-align:right;}
  .data th:first-child{text-align:left;} .data td{padding:9px 10px;font-size:11.5px;text-align:right;border-bottom:1px solid #f1f5f9;}
  .data td:first-child{text-align:left;} .data tr:last-child td{border-bottom:none;}
  .pill{display:inline-block;font-size:9px;font-weight:600;padding:2px 8px;border-radius:99px;white-space:nowrap;}
  .note{border:1px solid #fde68a;background:#fffbeb;border-radius:10px;padding:12px 15px;font-size:11.5px;color:${WARN};margin:0 0 16px;}
  .note-bad{border-color:#fecaca;background:#fef2f2;color:${BAD};}
  .prose{font-size:11.5px;color:#475569;line-height:1.75;} .prose strong{color:${INK};}
  .sign{margin-top:26px;padding-top:20px;border-top:1px solid ${LINE};} .sig-line{height:58px;border-bottom:1px solid ${INK};}
  .sig-name{font-size:11.5px;font-weight:600;margin-top:7px;} .sig-role{font-size:10px;color:${MUTED};margin-top:1px;}
  .foot{margin-top:20px;padding-top:11px;border-top:1px solid ${LINE};font-size:9.5px;color:#94a3b8;}
  @media print{.noprint{display:none!important;}}`;
}
function header(cfg, rightTitle, rightRef, rightMeta) {
  return `<table class="head"><tr>
    <td style="width:58%;vertical-align:middle;"><table><tr>
      <td style="width:42px;"><img src="${LOGO_DATA_URI}" style="height:34px;display:block;"></td>
      <td style="padding-left:10px;"><div class="brand">${cfg.COMPANY_NAME}</div><div class="brand-sub">${cfg.COMPANY_ADDR} &middot; ${cfg.SUPPORT_PHONE}</div></td>
    </tr></table></td>
    <td style="text-align:right;vertical-align:middle;"><div class="doc-title">${rightTitle}</div><div class="doc-ref">${rightRef}</div><div class="brand-sub">${rightMeta}</div></td>
  </tr></table>`;
}
function footer(cfg, dateStr, extra) {
  return `<table class="foot"><tr><td>${cfg.COMPANY_NAME} &middot; ${cfg.SUPPORT_EMAIL}</td>
    <td style="text-align:center;">${extra || ""}</td><td style="text-align:right;">Generated ${dateStr}</td></tr></table>`;
}
function signatures(cfg, borrowerName) {
  const sig = SIGNATURE_DATA_URI ? `<img src="${SIGNATURE_DATA_URI}" style="height:50px;display:block;margin:0 auto;">` : "";
  // vertical-align:top on every cell matters here: a <td> defaults to middle,
  // and the lender's cell is taller than the borrower's (it carries the
  // signature image, the borrower's side doesn't) -- left uncorrected, the
  // browser centers the shorter cell's content inside the row instead of
  // anchoring both at the same top edge, so the two signature lines end up
  // at different heights instead of level with each other.
  return `<div class="sign"><table><tr>
    <td style="width:45%;text-align:center;vertical-align:top;"><div class="sig-line">${sig}</div><div class="sig-name">${cfg.LENDER_NAME.toUpperCase()}</div><div class="sig-role">Lender</div></td>
    <td style="width:10%;vertical-align:top;"></td>
    <td style="width:45%;text-align:center;vertical-align:top;"><div class="sig-line"></div><div class="sig-name">${(borrowerName || "").toUpperCase()}</div><div class="sig-role">Borrower</div></td>
  </tr></table></div>`;
}
function printButton() {
  return `<div class="noprint" style="text-align:center;margin:22px 0 8px;"><button onclick="window.print()" style="background:#2563eb;color:#fff;border:0;padding:11px 26px;border-radius:9px;font:600 14px Helvetica,Arial,sans-serif;cursor:pointer;">Print or save as PDF</button></div>`;
}

const STATUS_TONE = {
  "\u2705 PAID": { fg: OK, bg: "#f0fdf4", label: "Paid" },
  "\u26A0\uFE0F OVERDUE": { fg: BAD, bg: "#fef2f2", label: "Overdue" },
  "\uD83D\uDCC9 PARTIAL": { fg: WARN, bg: "#fffbeb", label: "Partial" },
  "\u23F3 PENDING": { fg: MUTED, bg: SURF, label: "Pending" },
  "\uD83D\uDCB3 FOR PAYMENT": { fg: BRAND, bg: "#eff6ff", label: "For payment" },
  "\uD83D\uDC80 PAST TERM": { fg: "#991b1b", bg: "#fef2f2", label: "Past term" },
};
function pill(status) {
  const t = STATUS_TONE[status] || { fg: MUTED, bg: SURF, label: String(status || "").replace(/[^\x20-\x7E]/g, "").trim() };
  return `<span class="pill" style="color:${t.fg};background:${t.bg};">${t.label}</span>`;
}
function statusText(r) {
  const map = { PAID: "\u2705 PAID", OVERDUE: "\u26A0\uFE0F OVERDUE", PARTIAL: "\uD83D\uDCC9 PARTIAL", PENDING: "\u23F3 PENDING", FOR_PAYMENT: "\uD83D\uDCB3 FOR PAYMENT", PAST_TERM: "\uD83D\uDC80 PAST TERM" };
  return map[r.status] || r.status;
}

function buildSoaHtml(cfg, loanRow, bank, payments, schedule) {
  const now = new Date();
  const dateStr = fmtDate(now, "MMMM dd, yyyy");
  const { balanceFrom, owedToday, round2: r2 } = require("./engine");
  const balance = balanceFrom(schedule);
  const paid = r2(schedule.reduce((a, r) => a + r.paid, 0));
  const pct = paid + balance > 0 ? Math.min(100, Math.round((paid / (paid + balance)) * 100)) : 100;
  const ref = `SOA-${(loanRow.borrowers.name || "").split(" ").join("").toUpperCase().slice(0, 10)}-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;

  const payRows = payments.map((p) => `<tr><td>${p.month}</td><td style="color:${OK};font-weight:600;">${peso(p.amount)}</td>
      <td class="muted">${p.date ? fmtDate(p.date, "MM/dd/yyyy") : "\u2014"}</td><td class="muted mono" style="font-size:10px;">${p.receiptNo || "\u2014"}</td></tr>`).join("")
    || `<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:16px;">No payments recorded yet.</td></tr>`;

  const owed = owedToday(schedule);
  const nb = nextBillFrom({ schedule, bank });          // what is billed next, with any overdue kept on its own line before the statement date
  const lateFee = Number(loanRow.late_fee) || 0;
  const schedRows = schedule.map((r) => {
    const added = (r.penalty > 0 || r.lateFee > 0)
      ? `<div style="font-size:9.5px;color:${MUTED};">incl. ${r.penalty > 0 ? peso(r.penalty) + " penalty" : ""}${r.penalty > 0 && r.lateFee > 0 ? " + " : ""}${r.lateFee > 0 ? peso(r.lateFee) + " late fee" : ""}</div>` : "";
    const bal = r.carryOut > 0 ? `<span style="color:${BAD};font-weight:600;">${peso(r.carryOut)}</span>${added}`
      : r.carryOut < 0 ? `<span style="color:${OK};font-weight:600;">${peso(Math.abs(r.carryOut))} credit</span>`
      : (!r.isPast && r.outstanding > 0 && (r.paid > 0 || r.carryIn > 0)) ? `<span class="muted">${peso(r.outstanding)} still due</span>`
      : (r.isPast || r.paid > 0) ? `<span class="muted">cleared</span>` : `<span class="muted">not due yet</span>`;
    const breakdown = peso(r.amort)
      + (r.fee > 0 ? `<div style="font-size:9.5px;color:${MUTED};">+ ${peso(r.fee)} fee</div>` : "")
      + (r.carryIn > 0 ? `<div style="font-size:9.5px;color:${BAD};">+ ${peso(r.carryIn)} carried over</div>` : "")
      + (r.carryIn < 0 ? `<div style="font-size:9.5px;color:${OK};">\u2212 ${peso(Math.abs(r.carryIn))} credit</div>` : "");
    return `<tr${r.isExtension ? ' style="background:#fef2f2;"' : ""}>
      <td>${r.month}<div style="font-size:9.5px;color:${MUTED};">due ${r.dueDate}</div></td>
      <td>${r.isExtension ? peso(r.bill) : breakdown}</td>
      <td style="color:${r.paid > 0 ? OK : "#94a3b8"};font-weight:${r.paid > 0 ? 600 : 400};">${r.paid > 0 ? peso(r.paid) : "\u2014"}</td>
      <td>${bal}</td><td style="text-align:center;">${pill(statusText(r))}</td></tr>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Statement of Account \u2014 ${loanRow.borrowers.name}</title><style>${css()}</style></head><body>
  ${header(cfg, "Statement of Account", ref, "As of " + dateStr)}
  <table class="who"><tr><td><div class="who-name">${loanRow.borrowers.name}</div><div class="who-sub">${loanRow.borrowers.email} &middot; ${loanRow.loan_name}</div></td></tr></table>
  <table style="border-spacing:5px;border-collapse:separate;"><tr>
    <td class="tile" width="25%"><div class="tile-l">Balance</div><div class="tile-v" style="color:${BAD};">${peso(balance)}</div></td>
    <td class="tile" width="25%"><div class="tile-l">Paid to date</div><div class="tile-v" style="color:${OK};">${peso(paid)}</div></td>
    <td class="tile" width="25%"><div class="tile-l">${nb ? "Due next" : "Monthly amort"}</div><div class="tile-v" style="color:${BRAND};">${peso(nb ? nb.bill : loanRow.monthly_amort)}</div></td>
    <td class="tile" width="25%"><div class="tile-l">Remaining</div><div class="tile-v">${schedule.filter(r=>!r.isExtension&&r.outstanding>0).length} mos</div></td>
  </tr></table>
  <div class="card" style="margin:16px 0;"><table><tr><td style="font-size:11px;font-weight:600;">Repayment progress</td><td style="text-align:right;font-size:11px;font-weight:600;color:${BRAND};">${pct}%</td></tr></table>
    <table class="bar-wrap"><tr>${pct>0?`<td width="${pct}%" class="bar" style="font-size:1px;line-height:7px;">&#8203;</td>`:""}${pct<100?`<td width="${100-pct}%" style="font-size:1px;line-height:7px;">&#8203;</td>`:""}</tr></table>
  </div>
  ${owed > 0 ? `<div class="note note-bad"><strong>Overdue as of today: ${peso(owed)}</strong><br>Unpaid months accrue a ${cfg.PENALTY_RATE}% monthly penalty${lateFee > 0 ? ` and a flat late payment fee of ${peso(lateFee)} per late month` : ""} until settled.${nb && nb.overdueSeparate > 0 ? `<br>${peso(nb.overdueSeparate)} of this is listed separately and is not included in \u201CDue next\u201D; it is billed together with the next installment when its statement is issued on ${nb.mergesOn}.` : ""}</div>` : ""}
  <table style="border-spacing:8px;border-collapse:separate;margin:0 -8px 16px;"><tr>
    <td class="card" width="50%" style="vertical-align:top;"><div class="sec">Loan information</div><table class="kv">
      <tr><td>Loan</td><td>${loanRow.loan_name}</td></tr><tr><td>Start date</td><td>${fmtDate(loanRow.start_date, "MMMM dd, yyyy")}</td></tr>
      <tr><td>Original amount</td><td>${peso(loanRow.principal)}</td></tr><tr><td>Total payable</td><td>${peso(loanRow.total_payable)}</td></tr>
      <tr><td>Terms</td><td>${loanRow.terms} months</td></tr></table></td>
    <td class="card" width="50%" style="vertical-align:top;"><div class="sec">Interest &amp; fees</div><table class="kv">
      <tr><td>Monthly rate</td><td>${Number(loanRow.monthly_rate).toFixed(2)}%</td></tr><tr><td>Total interest</td><td>${peso(loanRow.total_interest)}</td></tr>
      <tr><td>Processing fee</td><td>${peso(loanRow.processing_fee)}</td></tr>${lateFee > 0 ? `<tr><td>Late payment fee</td><td>${peso(lateFee)} / late month</td></tr>` : ""}<tr><td>Financing partner</td><td>${bank?.name || "\u2014"}</td></tr></table></td>
  </tr></table>
  <div class="sec">Payment history</div><table class="data" style="margin-bottom:20px;"><thead><tr><th>Month</th><th>Amount paid</th><th>Date paid</th><th>Receipt no.</th></tr></thead><tbody>${payRows}</tbody></table>
  <div class="sec">Billing schedule</div><table class="data" style="margin-bottom:16px;"><thead><tr><th>Month</th><th>Bill</th><th>Paid</th><th>Balance</th><th style="text-align:center;">Status</th></tr></thead><tbody>${schedRows}</tbody></table>
  ${footer(cfg, dateStr, "Computer-generated \u2014 no signature required")}
  ${printButton()}
  </body></html>`;
}

function buildAgreementHtml(cfg, loanRow, bank) {
  const now = new Date();
  const dateStr = fmtDate(now, "MMMM dd, yyyy");
  const startFmt = fmtDate(loanRow.start_date, "MMMM dd, yyyy");
  const dueDay = loanRow.due_day || 1;
  const suffix = dueDay == 1 ? "st" : dueDay == 2 ? "nd" : dueDay == 3 ? "rd" : "th";
  const isCash = (loanRow.loan_name || "").toLowerCase().includes("cash");
  const release = isCash
    ? "The loan amount shall be released to the BORROWER in cash upon signing of this Agreement."
    : "The item/s subject of this loan have been delivered to and received by the BORROWER prior to the signing of this Agreement. This Agreement serves as acknowledgment of receipt and confirmation of the repayment terms.";
  const ref = `LA-${(loanRow.borrowers.name || "").split(" ").join("").toUpperCase().slice(0, 10)}-${now.getFullYear()}`;
  const b = loanRow.borrowers;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Loan Agreement \u2014 ${b.name}</title><style>${css()}</style></head><body>
  ${header(cfg, "Loan and Repayment Agreement", ref, "Executed on " + startFmt)}
  <div class="sec">I. Parties</div>
  <div class="prose" style="margin-bottom:12px;">This Agreement is made and executed on <strong>${startFmt}</strong> by and between:</div>
  <table style="border-spacing:8px;border-collapse:separate;margin:0 -8px 18px;"><tr>
    <td class="card" width="50%" style="vertical-align:top;"><div class="tile-l" style="margin-bottom:6px;">The Lender</div>
      <div style="font-size:13px;font-weight:600;">${cfg.LENDER_NAME}</div>
      <div style="font-size:10.5px;color:${MUTED};line-height:1.75;margin-top:4px;">${cfg.LENDER_ADDR}<br>${cfg.SUPPORT_PHONE}<br>${cfg.SUPPORT_EMAIL}</div></td>
    <td class="card" width="50%" style="vertical-align:top;"><div class="tile-l" style="margin-bottom:6px;">The Borrower</div>
      <div style="font-size:13px;font-weight:600;">${b.name}</div>
      <div style="font-size:10.5px;color:${MUTED};line-height:1.75;margin-top:4px;">${b.address || "___________________________"}<br>ID No: ${b.valid_id || "___________________"}<br>${b.contact || "___________________"}<br>${b.email}</div></td>
  </tr></table>
  <div class="sec">II. Nature of the loan</div><div class="prose" style="margin-bottom:18px;">${release}</div>
  <div class="sec">III. Financial disclosure</div>
  <div class="card" style="margin-bottom:18px;"><table class="kv">
    <tr><td>Principal amount</td><td>${peso(loanRow.principal)}</td></tr><tr><td>Loan name</td><td>${loanRow.loan_name}</td></tr>
    <tr><td>Loan type</td><td>${isCash ? "Cash loan" : "Item loan"}</td></tr><tr><td>Installment terms</td><td>${loanRow.terms} months</td></tr>
    <tr><td>Monthly interest rate</td><td>${Number(loanRow.monthly_rate).toFixed(2)}%</td></tr><tr><td>Processing fee</td><td>${peso(loanRow.processing_fee)}</td></tr>
    ${Number(loanRow.late_fee) > 0 ? `<tr><td>Late payment fee</td><td>${peso(loanRow.late_fee)} per late month</td></tr>` : ""}
    <tr><td>Total interest</td><td>${peso(loanRow.total_interest)}</td></tr>
    <tr><td style="color:${WARN};font-weight:600;">Monthly amortization</td><td style="color:${WARN};font-size:13px;">${peso(loanRow.monthly_amort)}</td></tr>
    <tr><td style="color:${OK};font-weight:600;">Total obligation</td><td style="color:${OK};font-size:13px;">${peso(loanRow.total_payable)}</td></tr>
  </table></div>
  <div class="sec">IV. Repayment terms</div>
  <div class="prose">The BORROWER shall pay the LENDER in <strong>${loanRow.terms} equal monthly installments</strong>.</div>
  <div class="note">Monthly amortization: <strong>${peso(loanRow.monthly_amort)}</strong><br>Due date: every <strong>${dueDay}${suffix}</strong> of the month</div>
  <div class="sec" style="margin-top:16px;">V. Default and penalties</div>
  <div class="prose" style="margin-bottom:18px;"><strong>Late payment.</strong> ${lateClauseText(cfg.PENALTY_RATE, loanRow.late_fee, loanRow.late_fee_from ? fmtDate(loanRow.late_fee_from, "MMMM dd, yyyy") : "").replace(/\n\n/g, "<br><br>")}<br><br>
  <strong>Acceleration.</strong> Failure to pay for two (2) consecutive periods makes the entire remaining balance immediately due and demandable.<br><br>
  <strong>Collection costs.</strong> The BORROWER shall be liable for attorney's fees and collection costs should legal action be taken.</div>
  <div class="sec">VI. Electronic communication</div>
  <div class="prose">By providing the email address <strong>${b.email}</strong>, the BORROWER agrees to receive billing statements, notices and payment reminders electronically.</div>
  <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${MUTED};text-align:center;margin-top:22px;">VII. Execution \u2014 signed on the date first written above</div>
  ${signatures(cfg, b.name)}
  ${footer(cfg, dateStr)}
  ${printButton()}
  </body></html>`;
}

module.exports = { buildSoaHtml, buildAgreementHtml };
