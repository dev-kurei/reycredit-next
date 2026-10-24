/*  ============================================================
    Email templates — ported design system (same as the web app):
    neutral surfaces, one accent colour, thin borders, table-based
    markup for compatibility with Gmail/Outlook/Apple Mail.
    Every function here is pure: (cfg, data) -> { subject, html }.
    ============================================================ */
const { peso, fmtDate } = require("./engine");

/**
 * Email-body logo: a real hosted URL on the app's own domain, not the base64
 * data URI used in documents.js and pdf-documents.js.
 *
 * Base64-embedded images render fine in a browser (confirmed working in the
 * standalone "view in browser" Loan Agreement / SOA pages) and in a
 * server-rendered PDF, but Gmail's own message-body rendering does not
 * reliably display inline base64 images the same way -- it showed as a
 * broken-image icon in the actual email even though the identical image data
 * displayed correctly everywhere else. A plain URL Gmail can fetch itself
 * avoids that entirely.
 */
function logoUrl(cfg) {
  const base = (cfg.PORTAL_URL || "https://reycredits.com").replace(/\/$/, "");
  return `${base}/logo.png`;
}

const INK = "#0f172a", MUTED = "#64748b", LINE = "#e2e8f0", SURF = "#f8fafc";
const BRAND = "#2563eb", OK = "#16a34a", BAD = "#dc2626", WARN = "#b45309";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

function shell(cfg, subtitle, body, note) {
  return `<div style="margin:0;padding:32px 12px;background:${SURF};font-family:${FONT};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid ${LINE};border-radius:14px;overflow:hidden;">
    <tr><td style="padding:30px 32px 24px;border-bottom:1px solid ${LINE};text-align:center;">
      <img src="${logoUrl(cfg)}" alt="${cfg.COMPANY_NAME}" width="56" style="display:block;width:56px;margin:0 auto 12px;border:0;">
      <div style="font-size:17px;font-weight:600;color:${INK};letter-spacing:-0.2px;">${cfg.COMPANY_NAME}</div>
      <div style="font-size:10px;font-weight:600;color:${BRAND};letter-spacing:2px;text-transform:uppercase;margin-top:5px;">${subtitle}</div>
    </td></tr>
    <tr><td style="padding:30px 32px;">${body}</td></tr>
    <tr><td style="background:${SURF};border-top:1px solid ${LINE};padding:24px 32px;text-align:center;">
      <img src="${logoUrl(cfg)}" alt="" width="30" style="display:block;width:30px;margin:0 auto 10px;border:0;opacity:0.75;">
      <div style="font-size:13px;font-weight:600;color:${INK};">${cfg.COMPANY_NAME}</div>
      <div style="font-size:12px;color:${MUTED};line-height:1.9;margin-top:5px;">
        ${cfg.COMPANY_ADDR} &middot; ${cfg.SUPPORT_PHONE}<br>
        <a href="mailto:${cfg.SUPPORT_EMAIL}" style="color:${BRAND};text-decoration:none;">${cfg.SUPPORT_EMAIL}</a>
      </div>
      <div style="font-size:11px;color:#94a3b8;line-height:1.7;margin-top:14px;padding-top:14px;border-top:1px solid ${LINE};">
        ${note}<br>&copy; ${new Date().getFullYear()} ${cfg.COMPANY_NAME}
      </div>
    </td></tr>
  </table></div>`;
}
const title = (t) => `<div style="font-size:19px;font-weight:600;color:${INK};letter-spacing:-0.3px;line-height:1.35;margin-bottom:8px;">${t}</div>`;
const text = (t) => `<p style="font-size:14px;color:#475569;line-height:1.65;margin:0 0 22px;">${t}</p>`;
function hero(label, value, sub, tone) {
  const c = tone === "bad" ? BAD : tone === "ok" ? OK : INK;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURF};border:1px solid ${LINE};border-radius:12px;margin-bottom:20px;">
    <tr><td style="padding:20px 22px;text-align:center;">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED};">${label}</div>
      <div style="font-size:30px;font-weight:700;color:${c};letter-spacing:-0.5px;margin:6px 0 3px;">${value}</div>
      <div style="font-size:13px;color:${MUTED};">${sub}</div>
    </td></tr></table>`;
}
function pair(l1, v1, t1, l2, v2, t2) {
  const cell = (l, v, t) => {
    const c = t === "bad" ? BAD : t === "ok" ? OK : INK;
    return `<td width="50%" style="padding:0 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:10px;">
      <tr><td style="padding:14px 16px;"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:${MUTED};">${l}</div>
      <div style="font-size:18px;font-weight:700;color:${c};letter-spacing:-0.3px;margin-top:5px;">${v}</div></td></tr></table></td>`;
  };
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -4px 20px;"><tr>${cell(l1,v1,t1)}${cell(l2,v2,t2)}</tr></table>`;
}
function progress(pct, caption) {
  const w = Math.max(0, Math.min(100, Math.round(pct)));
  const fill = w > 0 ? `<td width="${w}%" style="background:${BRAND};border-radius:99px;height:7px;font-size:1px;line-height:7px;">&#8203;</td>` : "";
  const rest = w < 100 ? `<td width="${100-w}%" style="font-size:1px;line-height:7px;">&#8203;</td>` : "";
  return `<div style="margin-bottom:20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:7px;"><tr>
      <td style="font-size:12px;color:${MUTED};">${caption}</td><td style="font-size:12px;font-weight:600;color:${INK};text-align:right;">${w}%</td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e2e8f0;border-radius:99px;height:7px;line-height:7px;"><tr>${fill}${rest}</tr></table>
  </div>`;
}
function panel(title, inner) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:12px;margin-bottom:20px;">
    <tr><td style="padding:14px 18px 10px;border-bottom:1px solid ${LINE};"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED};">${title}</div></td></tr>
    <tr><td style="padding:6px 18px 14px;">${inner}</td></tr></table>`;
}
function row(label, value, style) {
  return `<tr><td style="padding:9px 0;color:${MUTED};font-size:13px;border-bottom:1px solid #f1f5f9;">${label}</td>
    <td style="padding:9px 0;text-align:right;font-weight:600;color:${INK};font-size:13px;border-bottom:1px solid #f1f5f9;${style||""}">${value}</td></tr>`;
}
const table = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
function button(cfg, txt) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 6px;">
    <tr><td style="background:${BRAND};border-radius:9px;text-align:center;"><a href="${cfg.PORTAL_URL}" style="display:block;padding:13px;color:#fff;text-decoration:none;font-size:14px;font-weight:600;">${txt}</a></td></tr></table>`;
}
function notice(inner, tone) {
  const c = tone === "bad" ? BAD : WARN, bg = tone === "bad" ? "#fef2f2" : "#fffbeb", bd = tone === "bad" ? "#fecaca" : "#fde68a";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};border:1px solid ${bd};border-radius:10px;margin-bottom:20px;">
    <tr><td style="padding:13px 16px;font-size:13px;color:${c};line-height:1.6;">${inner}</td></tr></table>`;
}
function attached(title, sub) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px dashed ${LINE};border-radius:10px;margin-bottom:20px;">
    <tr><td style="padding:14px 18px;"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED};">Attached</div>
    <div style="font-size:14px;font-weight:600;color:${INK};margin-top:4px;">${title}</div><div style="font-size:12px;color:${MUTED};margin-top:2px;">${sub}</div></td></tr></table>`;
}
function support(cfg) {
  return `<p style="font-size:12px;color:${MUTED};line-height:1.7;margin:20px 0 0;padding-top:18px;border-top:1px solid ${LINE};">
    Questions? Call <a href="tel:${cfg.SUPPORT_PHONE}" style="color:${BRAND};font-weight:600;text-decoration:none;">${cfg.SUPPORT_PHONE}</a>
    or email <a href="mailto:${cfg.SUPPORT_EMAIL}" style="color:${BRAND};font-weight:600;text-decoration:none;">${cfg.SUPPORT_EMAIL}</a>.</p>`;
}

/* ---------------- actual emails ---------------- */

/** The late-payment notice, with the flat late fee when this loan's agreement has one. */
function lateNotice(cfg, lateFee) {
  return notice(`Payments received after the due date add a <strong>${cfg.PENALTY_RATE}% monthly</strong> penalty on the unpaid amount`
    + (Number(lateFee) > 0 ? ` and a flat late payment fee of <strong>${peso(lateFee)}</strong> for each late month.` : "."));
}

function resetPinEmail(cfg, { name, email, pin, forced }) {
  const body = title(forced ? "Your new portal PIN" : "Your temporary PIN")
    + text(forced
      ? `Hi ${name || email}, we have given every portal account a new, private PIN to keep your loan details safe. Use the PIN below to sign in, then change it right away from your profile. Your old password no longer works.`
      : `Hi ${name || email}, use the PIN below to sign in, then change it right away from your profile.`)
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURF};border:1px solid ${LINE};border-radius:12px;margin-bottom:20px;">
        <tr><td style="padding:22px;text-align:center;"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.7px;color:${MUTED};">Temporary PIN</div>
        <div style="font-size:34px;font-weight:700;font-family:${MONO};color:${INK};letter-spacing:9px;margin-top:8px;">${pin}</div></td></tr></table>`
    + button(cfg, "Sign in to my portal") + support(cfg);
  return { subject: `Your ${cfg.COMPANY_NAME} ${forced ? "new portal PIN" : "temporary PIN"}`, html: shell(cfg, forced ? "New portal PIN" : "Password reset", body, forced ? "Sent because your portal account was secured." : "If you didn't request this, contact us right away.") };
}

function welcomeEmail(cfg, { name, email, loanName, pin }) {
  const body = title(`Welcome to ${cfg.COMPANY_NAME}, ${name}`)
    + text("Your account is ready. Sign in any time to check your balance, due dates and payment history.")
    + panel("Your portal access", table(row("Portal", `<a href="${cfg.PORTAL_URL}" style="color:${BRAND};text-decoration:none;">${cfg.PORTAL_URL}</a>`) + row("Email", email) + (pin ? row("Your PIN", `<span style="font-family:${MONO};letter-spacing:4px;font-size:16px;font-weight:700;">${pin}</span>`) : row("Password", "Use the PIN from your first welcome email, or tap <strong>Forgot password</strong> on the sign-in page.")))) 
    + notice("Change your password after your first sign-in. We will never ask for it by email or text.")
    + attached(`Loan agreement — ${loanName}`, "Review, sign and keep a copy.")
    + button(cfg, "Open my portal") + support(cfg);
  return { subject: `Welcome to ${cfg.COMPANY_NAME} — your portal is ready`, html: shell(cfg, "Account created", body, "Sent because a loan account was opened in your name.") };
}

function newLoanEmail(cfg, { name, loanName, principal, monthlyRate, fee, totalInterest, totalPayable, terms, monthlyAmort, dueDateStr, lateFee }) {
  const body = title(`New loan added, ${name}`)
    + text("A new loan is now on your account. The signed agreement is attached as a PDF.")
    + hero("Monthly amortization", peso(monthlyAmort), `First payment due ${dueDateStr}`)
    + panel("Loan summary", table(row("Loan", loanName) + row("Principal", peso(principal)) + row("Monthly rate", monthlyRate) + row("Processing fee", peso(fee)) + (Number(lateFee) > 0 ? row("Late payment fee", `${peso(lateFee)} per late month`) : "") + row("Total interest", peso(totalInterest)) + row("Total payable", peso(totalPayable)) + row("Terms", `${terms} months`)))
    + attached(`Loan agreement — ${loanName}`, "Review, sign and keep a copy.")
    + lateNotice(cfg, lateFee)
    + button(cfg, "View this loan") + support(cfg);
  return { subject: `New loan on your account: ${loanName}`, html: shell(cfg, "New loan", body, "Sent because a loan was registered to your account.") };
}

function statementEmail(cfg, { name, loanName, monthLabel, next, pct, balance, paid, monthlyAmort, remaining, recentPayments }) {
  const dueStr = next ? fmtDate(next.dueDateObj, "MMMM dd, yyyy") : "see your portal";
  const rows = (recentPayments || []).slice(-6).reverse().map((p) =>
    `<tr><td style="padding:9px 0;color:${INK};font-size:13px;border-bottom:1px solid #f1f5f9;">${p.month}</td>
      <td style="padding:9px 0;text-align:right;font-weight:600;color:${OK};font-size:13px;border-bottom:1px solid #f1f5f9;">${peso(p.amount)}</td>
      <td style="padding:9px 0;text-align:right;color:${MUTED};font-size:12px;border-bottom:1px solid #f1f5f9;">${p.date || "—"}</td></tr>`).join("")
    || `<tr><td colspan="3" style="padding:16px 0;text-align:center;color:#94a3b8;font-size:13px;">No payments recorded yet.</td></tr>`;

  const body = title("Statement of account")
    + text(`Hi ${name}, here is where <strong>${loanName}</strong> stands as of ${monthLabel}.`)
    + (next ? hero("Amount due next", peso(next.bill), dueStr, "bad") : hero("Amount due next", peso(0), "Nothing due right now", "ok"))
    + (next && next.hasCarry && (next.penaltyCharged > 0 || next.lateFeesCharged > 0)
        ? notice(`This includes <strong>${peso(next.carryAmount)}</strong> carried over from earlier months. Charged on the unpaid amounts so far: <strong>${peso(next.penaltyCharged)}</strong> penalty`
            + (next.lateFeesCharged > 0 ? ` and <strong>${peso(next.lateFeesCharged)}</strong> late payment fees.` : "."), "bad") : "")
    + (next && next.overdueSeparate > 0 ? notice(`Also overdue: <strong>${peso(next.overdueSeparate)}</strong>, listed separately. It is billed together with your next installment when its statement is issued on ${next.mergesOn}.`, "bad") : "")
    + pair("Outstanding", peso(balance), "bad", "Paid to date", peso(paid), "ok")
    + progress(pct, "Repayment progress")
    + panel("This loan", table(row("Monthly amortization", peso(monthlyAmort)) + row("Remaining terms", `${remaining} months`) + row("Next payment due", dueStr, `color:${BAD};`)))
    + panel("Recent payments", table(rows))
    + attached(`Statement of account — ${monthLabel}`, "The full statement is available any time in your portal.")
    + button(cfg, "Open my portal") + support(cfg);
  return { subject: `${cfg.COMPANY_NAME} statement of account — ${monthLabel}`, html: shell(cfg, "Monthly statement", body, "Sent automatically on your bank's statement day.") };
}

function reminderEmail(cfg, { name, loanName, amount, dueStr, days, balance, remaining, hasCarry, carryAmount, lateFee, overdueSeparate, mergesOn }) {
  const headline = days < 0 ? `Payment overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}`
    : days === 0 ? "Payment due today" : `Payment due in ${days} day${days === 1 ? "" : "s"}`;
  const channels = table(row("GCash / Maya", `<span style="font-family:${MONO};">${cfg.GCASH_ACCOUNT}</span>`) + row("Maribank", `<span style="font-family:${MONO};">${cfg.MARIBANK_ACCOUNT}</span>`) + row("BPI", `<span style="font-family:${MONO};">${cfg.BPI_ACCOUNT}</span>`) + row("Walk in", `${cfg.COMPANY_ADDR} &middot; ${cfg.OFFICE_HOURS}`))
    + `<p style="font-size:12px;color:${MUTED};margin:12px 0 0;">All accounts are under <strong style="color:${INK};">${cfg.LENDER_NAME}</strong>.</p>`;
  const body = title(headline)
    + text(`Hi ${name}, this is a reminder for <strong>${loanName}</strong>.`)
    + hero("Amount due", peso(amount), `Due ${dueStr}`, days < 0 ? "bad" : null)
    + (hasCarry ? notice(`This includes <strong>${peso(carryAmount)}</strong> carried over from earlier months.`, "bad") : "")
    + (overdueSeparate > 0 ? notice(`Also overdue: <strong>${peso(overdueSeparate)}</strong> (penalty and late fees included), listed separately. It is billed together with your next installment when its statement is issued on ${mergesOn}.`, "bad") : "")
    + panel("Account summary", table(row("Loan", loanName) + row("Remaining balance", peso(balance), `color:${BAD};`) + row("Months remaining", `${remaining} months`)))
    + panel("Where to pay", channels)
    + lateNotice(cfg, lateFee)
    + button(cfg, "View my account")
    + `<p style="font-size:12px;color:#94a3b8;text-align:center;margin:14px 0 0;">Already paid? Please ignore this reminder.</p>` + support(cfg);
  return { subject: `Reminder: ${peso(amount)} due ${dueStr}`, html: shell(cfg, "Payment reminder", body, "Sent automatically before your due date.") };
}

function receiptEmail(cfg, { name, loanName, amount, month, dateStr, method, receiptNo, balance, paid, pct, next, remaining, applied }) {
  const body = title(`Thank you, ${name}`)
    + text(`We have received your payment for <strong>${loanName}</strong>.`)
    + hero("Payment received", peso(amount), `${month} &middot; ${dateStr}`, "ok")
    + panel("Receipt", table(row("Receipt no.", `<span style="font-family:${MONO};font-size:12px;">${receiptNo}</span>`) + row("Payment for", month) + row("Method", method) + row("Date paid", dateStr)
      + (applied ? row("Applied to your loan", peso(applied.toInstalments)) + row("Applied to penalty &amp; late fees", peso(applied.toCharges)) : "")))
    + pair("Remaining balance", peso(balance), "bad", "Paid to date", peso(paid), "ok")
    + progress(pct, "Repayment progress")
    + panel("Next payment", table(row("Due date", next ? fmtDate(next.dueDateObj, "MMMM dd, yyyy") : "—") + row("Amount", next ? peso(next.bill) : peso(0), `color:${WARN};`) + (next && next.overdueSeparate > 0 ? row("Overdue (separate)", peso(next.overdueSeparate), `color:${BAD};`) : "") + row("Months remaining", `${remaining} months`)))
    + button(cfg, "View my account") + support(cfg);
  return { subject: `Receipt ${receiptNo} — ${cfg.COMPANY_NAME}`, html: shell(cfg, "Official receipt", body, "Keep this email as proof of payment.") };
}

/** Announcement to every borrower with an active loan: a flat late payment fee is being introduced. */
function lateFeeNoticeEmail(cfg, { name, loans, amount, effectiveStr }) {
  const list = (loans || []).filter(Boolean);
  const loansText = list.length ? list.map((l) => String(l).replace(/</g, "&lt;")).join("<br>") : "Your loan";
  const body = title("Important notice: late payment fee")
    + text(`Hi ${name}, we are adding a flat late payment fee to the terms of your loan${list.length > 1 ? "s" : ""}. Please take a minute to read how it works.`)
    + hero("Late payment fee", peso(amount), `per late month &middot; starts ${effectiveStr}`, "bad")
    + panel("What is changing", table(
        row("Starts", effectiveStr)
      + row("Late payment fee", `${peso(amount)} per late month`)
      + row("Late penalty", `${cfg.PENALTY_RATE}% of the full bill if not paid in full on the due date`)
      + row("Your loan" + (list.length > 1 ? "s" : ""), loansText)))
    + panel("How it works", `<div style="font-size:13px;color:#475569;line-height:1.7;padding-top:6px;">
        <div style="margin-bottom:8px;">&bull; If an installment is not fully received on or before its due date, <strong>one late payment fee</strong> is added to your balance for that month.</div>
        <div style="margin-bottom:8px;">&bull; The <strong>${cfg.PENALTY_RATE}% penalty</strong> is computed on the <strong>full bill</strong> of that month (not only the unpaid part) whenever it is not paid in full by the due date, even if part of it was paid early. It is charged once for that month and <strong>is not removed by paying later</strong>. The penalty and late fee are charged on top of your installment and do not reduce it.</div>
        <div style="margin-bottom:8px;">&bull; Paying in full <strong>on the due date is on time</strong>. No fee or penalty is charged.</div>
        <div style="margin-bottom:8px;">&bull; The late payment fee applies only to installments falling due on or after <strong>${effectiveStr}</strong>. No late fee is charged for earlier months.</div>
        <div style="margin-bottom:8px;">&bull; When you pay, the money goes to any penalty and late fee first, and the rest reduces your loan. Your receipt shows how each payment was applied.</div>
        <div>&bull; Overdue amounts, with their penalty and late fees, are shown as a separate line until the statement date, then billed together with your next installment.</div></div>`)
    + panel("Legal basis", `<div style="font-size:12.5px;color:#475569;line-height:1.65;padding-top:6px;">
        <div style="margin-bottom:8px;">&bull; <strong>Freedom to contract.</strong> Under Articles 1306 and 1159 of the Civil Code, the parties may agree on any terms that are not contrary to law, morals, good customs, public order or public policy, and a contract has the force of law between them. These charges become part of your loan only with your agreement, which is why we are asking for it.</div>
        <div style="margin-bottom:8px;">&bull; <strong>In writing and disclosed.</strong> Interest and charges must be stipulated in writing (Art. 1956, Civil Code), and the cost of credit must be disclosed to the borrower (Truth in Lending Act, R.A. 3765). This notice, your reply, and your updated Loan Agreement are that written record.</div>
        <div style="margin-bottom:8px;">&bull; <strong>Penalty clause.</strong> A stipulated penalty for late payment is allowed (Arts. 1226 and 1228). An unpaid penalty or fee may be added to the overdue amount, and interest on it may be agreed (Art. 1959). Your Loan Agreement states this expressly.</div>
        <div style="margin-bottom:8px;">&bull; <strong>Reasonable rates.</strong> Interest ceilings under the Usury Law are no longer imposed (Central Bank Circular 905), but courts may reduce charges that are excessive (Art. 1229). Our ${cfg.PENALTY_RATE}% monthly penalty is below the 5% per month that the SEC allows for small, short-term loans (SEC Memorandum Circular 3, s. 2022), which we use as our reference.</div>
        <div>This is a summary and not legal advice. If you have questions, reply to this email.</div></div>`)
    + notice(`Please <strong>reply to this email with &ldquo;I agree&rdquo;</strong> to confirm you have read this notice. If you have questions or do not agree, let us know before ${effectiveStr}. An updated copy of your Loan Agreement is available on request.`)
    + button(cfg, "Open my portal") + support(cfg);
  return { subject: `Notice: ${peso(amount)} late payment fee starts ${effectiveStr}`, html: shell(cfg, "Account notice", body, "Sent to every borrower with an active loan.") };
}

const escHtml = (t) => String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A message the admin writes. The text is escaped (it can never inject markup), blank lines start a
 * new paragraph, and {name} / {loans} are filled in per borrower.
 */
function announcementEmail(cfg, { name, loans, subject, message, button }) {
  const loansText = (loans || []).filter(Boolean).join(", ");
  const fill = (t) => String(t).replace(/\{name\}/gi, () => name || "").replace(/\{loans?\}/gi, () => loansText);
  const paras = fill(message).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => text(escHtml(p).replace(/\n/g, "<br>")).replace("margin:0 0 22px", "margin:0 0 16px")).join("");
  const body = title(escHtml(fill(subject)))
    + text(`Hi ${escHtml(name)},`)
    + paras
    + (button === false ? "" : button_(cfg))
    + support(cfg);
  return { subject: fill(subject), html: shell(cfg, "Announcement", body, "Sent to our borrowers by " + cfg.COMPANY_NAME + ".") };
}
const button_ = (cfg) => button(cfg, "Open my portal");

module.exports = { announcementEmail, lateFeeNoticeEmail, resetPinEmail, welcomeEmail, newLoanEmail, statementEmail, reminderEmail, receiptEmail };
