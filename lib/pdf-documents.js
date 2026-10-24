/*  ============================================================
    Real PDF attachments for emails, using @react-pdf/renderer.
    ------------------------------------------------------------
    Chosen over Puppeteer + headless Chromium deliberately: Chromium's
    serverless build still runs ~50MB and 400-600MB of memory per call,
    which sits uncomfortably close to Vercel's Hobby-plan limits and
    makes cold starts slow. @react-pdf/renderer has no browser engine at
    all -- it draws the PDF directly -- so it adds about 2MB and renders
    in well under a second.

    @react-pdf/renderer ships as an ESM-only package, which Next.js's
    bundler refuses to pull in through a plain require() -- "ESM packages
    need to be imported" is a build-time error, not a suggestion. Every
    export used here comes through a dynamic import() instead, done once
    and cached for the lifetime of the warm serverless instance.

    The trade-off against the HTML/CSS versions in documents.js: layouts
    here are built from these components (Document, Page, View, Text,
    Image), not raw markup. The content mirrors the HTML versions; the
    markup underneath does not.

    Written with React.createElement rather than JSX, matching the
    plain-.js, no-build-step style of the rest of lib/.
    ============================================================ */
const React = require("react");
const path = require("path");
const { peso, fmtDate, balanceFrom, owedToday, round2, lateClauseText, nextBillFrom } = require("./engine");
const LOGO_DATA_URI = require("./assets/logo-data-uri");
const SIGNATURE_DATA_URI = require("./assets/signature-data-uri");

const e = React.createElement;

const INK = "#0f172a", MUTED = "#64748b", LINE = "#e2e8f0", SURF = "#f8fafc";
const BRAND = "#2563eb", OK = "#16a34a", BAD = "#dc2626", WARN = "#b45309";

const STATUS_TONE = {
  PAID: { fg: OK, bg: "#f0fdf4", label: "Paid" },
  OVERDUE: { fg: BAD, bg: "#fef2f2", label: "Overdue" },
  PARTIAL: { fg: WARN, bg: "#fffbeb", label: "Partial" },
  PENDING: { fg: MUTED, bg: SURF, label: "Pending" },
  FOR_PAYMENT: { fg: BRAND, bg: "#eff6ff", label: "For payment" },
  PAST_TERM: { fg: "#991b1b", bg: "#fef2f2", label: "Past term" },
};

/**
 * Dynamically imports @react-pdf/renderer (required, since it is ESM-only),
 * registers the Unicode font, and builds the shared stylesheet -- once per
 * warm instance, cached afterwards. Everything that touches the library's
 * components goes through this.
 */
let _kit = null;
async function pdfKit() {
  if (_kit) return _kit;
  const { Document, Page, Text, View, Image, StyleSheet, Font, renderToBuffer } = await import("@react-pdf/renderer");

  // The PDF's default (Helvetica, one of the 14 standard PDF fonts) cannot
  // render the peso sign (U+20B1) -- it silently substitutes the wrong glyph,
  // which is unacceptable on a financial document where every figure carries
  // it. DejaVu Sans is bundled as a real npm dependency (not fetched over the
  // network at render time, which would be a reliability risk in a
  // serverless function) and has full coverage for it.
  //
  // The path below is built from process.cwd(), not __dirname and never
  // require.resolve(). Two bugs lived here in turn:
  //   require.resolve() got "optimized" by webpack into its own internal
  //   numeric module id instead of a real string path ("The 'path' argument
  //   must be of type string. Received type number (9473)").
  //   __dirname fixed that, but __dirname reflects where webpack places the
  //   bundled CHUNK, not where the original source file lived -- Next.js
  //   nests route chunks under .next/server/app/... at a depth that isn't the
  //   same as this file's one-level-under-the-project-root position in
  //   source, so a fixed number of ".." steps landed inside that nested
  //   folder instead of at the real project root (ENOENT for a path like
  //   ".../server/app/api/node_modules/...").
  // process.cwd() sidesteps both: Vercel always runs a Node serverless
  // function with its working directory set to the function's own root,
  // which is exactly where output file tracing places node_modules --
  // regardless of how many directories deep the calling chunk is nested.
  const fontDir = path.join(process.cwd(), "node_modules", "dejavu-fonts-ttf", "ttf");
  Font.register({
    family: "DejaVu",
    fonts: [
      { src: path.join(fontDir, "DejaVuSans.ttf") },
      { src: path.join(fontDir, "DejaVuSans-Bold.ttf"), fontWeight: "bold" },
    ],
  });

  const S = StyleSheet.create({
    page: { padding: 36, fontSize: 9.5, color: INK, fontFamily: "DejaVu" },
    row: { flexDirection: "row" },
    spaceBetween: { flexDirection: "row", justifyContent: "space-between" },

    head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: 12, marginBottom: 16, borderBottomWidth: 1, borderBottomColor: LINE },
    logo: { width: 30, height: 30, marginRight: 8 },
    brand: { fontSize: 13, fontFamily: "DejaVu", fontWeight: "bold" },
    brandSub: { fontSize: 7.5, color: MUTED, marginTop: 1 },
    docTitle: { fontSize: 12, fontFamily: "DejaVu", fontWeight: "bold", textAlign: "right" },
    docRef: { fontSize: 7.5, color: MUTED, textAlign: "right", marginTop: 2, fontFamily: "Courier" },

    who: { borderWidth: 1, borderColor: LINE, borderRadius: 6, padding: 10, marginBottom: 12 },
    whoName: { fontSize: 12, fontFamily: "DejaVu", fontWeight: "bold" },
    whoSub: { fontSize: 8, color: MUTED, marginTop: 2 },

    tileRow: { flexDirection: "row", marginBottom: 12, gap: 6 },
    tile: { flex: 1, borderWidth: 1, borderColor: LINE, borderRadius: 6, padding: 8 },
    tileLabel: { fontSize: 6.5, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5 },
    tileValue: { fontSize: 11, fontFamily: "DejaVu", fontWeight: "bold", marginTop: 3 },

    barOuter: { height: 5, backgroundColor: "#e2e8f0", borderRadius: 3, marginTop: 5, marginBottom: 14, flexDirection: "row" },
    barFill: { height: 5, backgroundColor: BRAND, borderRadius: 3 },

    notice: { borderWidth: 1, borderColor: "#fecaca", backgroundColor: "#fef2f2", borderRadius: 6, padding: 9, marginBottom: 12 },
    noticeText: { fontSize: 8.5, color: BAD, lineHeight: 1.4 },

    sec: { fontSize: 8, fontFamily: "DejaVu", fontWeight: "bold", color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, paddingBottom: 4, marginBottom: 7, borderBottomWidth: 1, borderBottomColor: LINE },

    twoCol: { flexDirection: "row", gap: 8, marginBottom: 12 },
    card: { flex: 1, borderWidth: 1, borderColor: LINE, borderRadius: 6, padding: 9 },

    kvRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: "#f1f5f9" },
    kvLabel: { fontSize: 8.5, color: MUTED },
    kvValue: { fontSize: 8.5, fontFamily: "DejaVu", fontWeight: "bold" },

    table: { borderWidth: 1, borderColor: LINE, borderRadius: 6, marginBottom: 12, overflow: "hidden" },
    thRow: { flexDirection: "row", backgroundColor: SURF, borderBottomWidth: 1, borderBottomColor: LINE },
    th: { fontSize: 6.5, fontFamily: "DejaVu", fontWeight: "bold", color: MUTED, textTransform: "uppercase", padding: 5, letterSpacing: 0.4 },
    tr: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#f1f5f9" },
    td: { fontSize: 8, padding: 5 },

    pill: { fontSize: 6.5, fontFamily: "DejaVu", fontWeight: "bold", paddingVertical: 2, paddingHorizontal: 5, borderRadius: 8, alignSelf: "flex-start" },

    foot: { position: "absolute", bottom: 24, left: 36, right: 36, paddingTop: 8, borderTopWidth: 1, borderTopColor: LINE, flexDirection: "row", justifyContent: "space-between", fontSize: 7, color: "#94a3b8" },

    prose: { fontSize: 8.5, color: "#475569", lineHeight: 1.5, marginBottom: 10 },
    signRow: { flexDirection: "row", marginTop: 30, justifyContent: "space-between" },
    sigBox: { width: "44%", alignItems: "center" },
    // A fixed-height slot for the (optional) signature image, the same on
    // both sides. Without this, the lender's signature image sits ABOVE its
    // line as an extra sibling, pushing that line down by the image's height
    // -- the borrower's side has no image, so nothing pushes its line down,
    // and the two lines end up at different heights instead of level.
    // Reserving the same empty space on both sides keeps them aligned.
    sigImageSlot: { height: 34, justifyContent: "flex-end", alignItems: "center" },
    sigLine: { borderBottomWidth: 1, borderBottomColor: INK, height: 34, width: "100%" },
    sigName: { fontSize: 8.5, fontFamily: "DejaVu", fontWeight: "bold", marginTop: 5 },
    sigRole: { fontSize: 7, color: MUTED, marginTop: 1 },
  });

  function pill(status) {
    const t = STATUS_TONE[status] || { fg: MUTED, bg: SURF, label: String(status || "") };
    return e(Text, { style: [S.pill, { color: t.fg, backgroundColor: t.bg }] }, t.label);
  }
  function headerBlock(cfg, rightTitle, rightRef, rightMeta) {
    return e(View, { style: S.head },
      e(View, { style: S.row },
        e(Image, { src: LOGO_DATA_URI, style: S.logo }),
        e(View, null,
          e(Text, { style: S.brand }, cfg.COMPANY_NAME),
          e(Text, { style: S.brandSub }, `${cfg.COMPANY_ADDR} \u00B7 ${cfg.SUPPORT_PHONE}`)
        )
      ),
      e(View, null,
        e(Text, { style: S.docTitle }, rightTitle),
        e(Text, { style: S.docRef }, rightRef),
        e(Text, { style: S.brandSub }, rightMeta)
      )
    );
  }
  function footerBlock(cfg, dateStr, extra) {
    return e(View, { style: S.foot, fixed: true },
      e(Text, null, `${cfg.COMPANY_NAME} \u00B7 ${cfg.SUPPORT_EMAIL}`),
      e(Text, null, extra || ""),
      e(Text, null, `Generated ${dateStr}`)
    );
  }
  function tile(label, value, color) {
    return e(View, { style: S.tile },
      e(Text, { style: S.tileLabel }, label),
      e(Text, { style: [S.tileValue, color ? { color } : null] }, value)
    );
  }
  function kv(label, value, color) {
    return e(View, { style: S.kvRow },
      e(Text, { style: S.kvLabel }, label),
      e(Text, { style: [S.kvValue, color ? { color } : null] }, value)
    );
  }
  function progressBar(pct) {
    const w = Math.max(0, Math.min(100, Math.round(pct)));
    return e(View, { style: S.barOuter }, e(View, { style: [S.barFill, { width: `${w}%` }] }));
  }

  _kit = { Document, Page, Text, View, Image, S, renderToBuffer, pill, headerBlock, footerBlock, tile, kv, progressBar };
  return _kit;
}

/* ---------------- Statement of Account ---------------- */
async function buildSoaPdf(cfg, loanRow, bank, payments, schedule) {
  const { Document, Page, Text, View, S, pill, headerBlock, footerBlock, tile, kv, progressBar } = await pdfKit();

  const now = new Date();
  const dateStr = fmtDate(now, "MMMM dd, yyyy");
  const balance = balanceFrom(schedule);
  const paid = round2(schedule.reduce((a, r) => a + r.paid, 0));
  const pct = paid + balance > 0 ? Math.min(100, Math.round((paid / (paid + balance)) * 100)) : 100;
  const owed = owedToday(schedule);
  const nb = nextBillFrom({ schedule, bank });   // overdue stays on its own line until the statement date
  const lateFee = Number(loanRow.late_fee) || 0;
  const remaining = schedule.filter((r) => !r.isExtension && r.outstanding > 0).length;
  const ref = `SOA-${(loanRow.borrowers.name || "").split(" ").join("").toUpperCase().slice(0, 10)}-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;

  const payRows = payments.length
    ? payments.map((p, i) => e(View, { style: S.tr, key: "p" + i },
        e(Text, { style: [S.td, { width: "34%" }] }, p.month),
        e(Text, { style: [S.td, { width: "22%", color: OK, fontFamily: "DejaVu", fontWeight: "bold" }] }, peso(p.amount)),
        e(Text, { style: [S.td, { width: "22%", color: MUTED }] }, p.date ? fmtDate(p.date, "MM/dd/yyyy") : "\u2014"),
        e(Text, { style: [S.td, { width: "22%", color: MUTED, fontSize: 7 }] }, p.receiptNo || "\u2014")
      ))
    : [e(View, { style: S.tr }, e(Text, { style: [S.td, { width: "100%", textAlign: "center", color: "#94a3b8" }] }, "No payments recorded yet."))];

  const schedRows = schedule.map((r, i) => {
    const balCell = r.carryOut > 0 ? e(Text, { style: { color: BAD, fontFamily: "DejaVu", fontWeight: "bold", fontSize: 8 } }, peso(r.carryOut))
      : r.carryOut < 0 ? e(Text, { style: { color: OK, fontFamily: "DejaVu", fontWeight: "bold", fontSize: 8 } }, `${peso(Math.abs(r.carryOut))} credit`)
      : (!r.isPast && r.outstanding > 0 && (r.paid > 0 || r.carryIn > 0)) ? e(Text, { style: { color: MUTED, fontSize: 8 } }, `${peso(r.outstanding)} still due`)
      : (r.isPast || r.paid > 0) ? e(Text, { style: { color: MUTED, fontSize: 8 } }, "cleared")
      : e(Text, { style: { color: MUTED, fontSize: 8 } }, "not due yet");
    const addedTxt = (r.penalty > 0 || r.lateFee > 0)
      ? `incl. ${r.penalty > 0 ? peso(r.penalty) + " penalty" : ""}${r.penalty > 0 && r.lateFee > 0 ? " + " : ""}${r.lateFee > 0 ? peso(r.lateFee) + " late fee" : ""}` : "";
    const balShown = (r.carryOut > 0 && addedTxt) ? e(View, null, balCell, e(Text, { style: { fontSize: 6, color: MUTED, marginTop: 1 } }, addedTxt)) : balCell;
    return e(View, { style: [S.tr, r.isExtension ? { backgroundColor: "#fef2f2" } : null], key: "s" + i },
      e(View, { style: { width: "30%", padding: 5 } }, e(Text, { style: { fontSize: 8 } }, r.month), e(Text, { style: { fontSize: 6.5, color: MUTED, marginTop: 1 } }, `due ${r.dueDate}`)),
      e(View, { style: { width: "22%", padding: 5 } }, e(Text, { style: { fontSize: 8 } }, r.isExtension ? peso(r.bill) : peso(r.amort))),
      e(View, { style: { width: "20%", padding: 5 } }, e(Text, { style: { fontSize: 8, color: r.paid > 0 ? OK : "#94a3b8", fontFamily: "DejaVu", fontWeight: r.paid > 0 ? "bold" : "normal" } }, r.paid > 0 ? peso(r.paid) : "\u2014")),
      e(View, { style: { width: "16%", padding: 5 } }, balShown),
      e(View, { style: { width: "12%", padding: 5, alignItems: "center" } }, pill(r.status))
    );
  });

  return e(Document, null,
    e(Page, { size: "LETTER", style: S.page },
      headerBlock(cfg, "Statement of Account", ref, `As of ${dateStr}`),
      e(View, { style: S.who },
        e(Text, { style: S.whoName }, loanRow.borrowers.name),
        e(Text, { style: S.whoSub }, `${loanRow.borrowers.email} \u00B7 ${loanRow.loan_name}`)
      ),
      e(View, { style: S.tileRow },
        tile("Balance", peso(balance), BAD),
        tile("Paid to date", peso(paid), OK),
        tile(nb ? "Due next" : "Monthly amort", peso(nb ? nb.bill : loanRow.monthly_amort), BRAND),
        tile("Remaining", `${remaining} mos`)
      ),
      e(View, { style: { marginBottom: 14 } },
        e(View, { style: S.spaceBetween },
          e(Text, { style: { fontSize: 8.5, fontFamily: "DejaVu", fontWeight: "bold" } }, "Repayment progress"),
          e(Text, { style: { fontSize: 8.5, fontFamily: "DejaVu", fontWeight: "bold", color: BRAND } }, `${pct}%`)
        ),
        progressBar(pct)
      ),
      owed > 0 ? e(View, { style: S.notice },
        e(Text, { style: [S.noticeText, { fontFamily: "DejaVu", fontWeight: "bold" }] }, `Overdue as of today: ${peso(owed)}`),
        e(Text, { style: S.noticeText }, `Unpaid months accrue a ${cfg.PENALTY_RATE}% monthly penalty${lateFee > 0 ? ` and a flat late payment fee of ${peso(lateFee)} per late month` : ""} until settled.`),
        nb && nb.overdueSeparate > 0 ? e(Text, { style: S.noticeText }, `${peso(nb.overdueSeparate)} of this is listed separately and is not included in "Due next"; it is billed together with the next installment when its statement is issued on ${nb.mergesOn}.`) : null
      ) : null,
      e(View, { style: S.twoCol },
        e(View, { style: S.card },
          e(Text, { style: S.sec }, "Loan information"),
          kv("Loan", loanRow.loan_name), kv("Start date", fmtDate(loanRow.start_date, "MMMM dd, yyyy")),
          kv("Original amount", peso(loanRow.principal)), kv("Total payable", peso(loanRow.total_payable)),
          kv("Terms", `${loanRow.terms} months`)
        ),
        e(View, { style: S.card },
          e(Text, { style: S.sec }, "Interest & fees"),
          kv("Monthly rate", `${Number(loanRow.monthly_rate).toFixed(2)}%`), kv("Total interest", peso(loanRow.total_interest)),
          kv("Processing fee", peso(loanRow.processing_fee)), ...(lateFee > 0 ? [kv("Late payment fee", `${peso(lateFee)} / late month`)] : []), kv("Financing partner", bank?.name || "\u2014")
        )
      ),
      e(Text, { style: S.sec }, "Payment history"),
      e(View, { style: S.table },
        e(View, { style: S.thRow },
          e(Text, { style: [S.th, { width: "34%" }] }, "Month"), e(Text, { style: [S.th, { width: "22%" }] }, "Amount paid"),
          e(Text, { style: [S.th, { width: "22%" }] }, "Date paid"), e(Text, { style: [S.th, { width: "22%" }] }, "Receipt no.")
        ),
        ...payRows
      ),
      e(Text, { style: S.sec }, "Billing schedule"),
      e(View, { style: S.table },
        e(View, { style: S.thRow },
          e(Text, { style: [S.th, { width: "30%" }] }, "Month"), e(Text, { style: [S.th, { width: "22%" }] }, "Bill"),
          e(Text, { style: [S.th, { width: "20%" }] }, "Paid"), e(Text, { style: [S.th, { width: "16%" }] }, "Balance"),
          e(Text, { style: [S.th, { width: "12%", textAlign: "center" }] }, "Status")
        ),
        ...schedRows
      ),
      footerBlock(cfg, dateStr, "Computer-generated \u2014 no signature required")
    )
  );
}

/* ---------------- Loan Agreement ---------------- */
async function buildAgreementPdf(cfg, loanRow, bank) {
  const { Document, Page, Text, View, Image, S, headerBlock, footerBlock, kv } = await pdfKit();

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

  return e(Document, null,
    e(Page, { size: "LETTER", style: S.page },
      headerBlock(cfg, "Loan and Repayment Agreement", ref, `Executed on ${startFmt}`),
      e(Text, { style: S.sec }, "I. Parties"),
      e(Text, { style: S.prose }, `This Agreement is made and executed on ${startFmt} by and between:`),
      e(View, { style: S.twoCol },
        e(View, { style: S.card },
          e(Text, { style: [S.tileLabel, { marginBottom: 5 }] }, "The Lender"),
          e(Text, { style: { fontSize: 10, fontFamily: "DejaVu", fontWeight: "bold" } }, cfg.LENDER_NAME),
          e(Text, { style: { fontSize: 8, color: MUTED, marginTop: 4, lineHeight: 1.5 } }, `${cfg.LENDER_ADDR}\n${cfg.SUPPORT_PHONE}\n${cfg.SUPPORT_EMAIL}`)
        ),
        e(View, { style: S.card },
          e(Text, { style: [S.tileLabel, { marginBottom: 5 }] }, "The Borrower"),
          e(Text, { style: { fontSize: 10, fontFamily: "DejaVu", fontWeight: "bold" } }, b.name),
          e(Text, { style: { fontSize: 8, color: MUTED, marginTop: 4, lineHeight: 1.5 } },
            `${b.address || "___________________"}\nID No: ${b.valid_id || "___________"}\n${b.contact || "___________"}\n${b.email}`)
        )
      ),
      e(Text, { style: S.sec }, "II. Nature of the loan"),
      e(Text, { style: S.prose }, release),
      e(Text, { style: S.sec }, "III. Financial disclosure"),
      e(View, { style: [S.card, { marginBottom: 14 }] },
        kv("Principal amount", peso(loanRow.principal)), kv("Loan name", loanRow.loan_name),
        kv("Loan type", isCash ? "Cash loan" : "Item loan"), kv("Installment terms", `${loanRow.terms} months`),
        kv("Monthly interest rate", `${Number(loanRow.monthly_rate).toFixed(2)}%`), kv("Processing fee", peso(loanRow.processing_fee)),
        ...(Number(loanRow.late_fee) > 0 ? [kv("Late payment fee", `${peso(loanRow.late_fee)} per late month`)] : []),
        kv("Total interest", peso(loanRow.total_interest)),
        kv("Monthly amortization", peso(loanRow.monthly_amort), WARN),
        kv("Total obligation", peso(loanRow.total_payable), OK)
      ),
      e(Text, { style: S.sec }, "IV. Repayment terms"),
      e(Text, { style: S.prose }, `The BORROWER shall pay the LENDER in ${loanRow.terms} equal monthly installments.`),
      e(View, { style: { borderWidth: 1, borderColor: "#fde68a", backgroundColor: "#fffbeb", borderRadius: 6, padding: 9, marginBottom: 12 } },
        e(Text, { style: { fontSize: 8.5, color: WARN, lineHeight: 1.5 } }, `Monthly amortization: ${peso(loanRow.monthly_amort)}\nDue date: every ${dueDay}${suffix} of the month`)
      ),
      e(Text, { style: S.sec }, "V. Default and penalties"),
      e(Text, { style: S.prose },
        `Late payment. ${lateClauseText(cfg.PENALTY_RATE, loanRow.late_fee, loanRow.late_fee_from ? fmtDate(loanRow.late_fee_from, "MMMM dd, yyyy") : "")}\n\n` +
        "Acceleration. Failure to pay for two (2) consecutive periods makes the entire remaining balance immediately due and demandable.\n\n" +
        "Collection costs. The BORROWER shall be liable for attorney's fees and collection costs should legal action be taken."),
      e(Text, { style: S.sec }, "VI. Electronic communication"),
      e(Text, { style: S.prose }, `By providing the email address ${b.email}, the BORROWER agrees to receive billing statements, notices and payment reminders electronically.`),
      e(Text, { style: { fontSize: 7, fontFamily: "DejaVu", fontWeight: "bold", color: MUTED, textTransform: "uppercase", letterSpacing: 1, textAlign: "center", marginTop: 16 } },
        "VII. Execution \u2014 signed on the date first written above"),
      e(View, { style: S.signRow },
        e(View, { style: S.sigBox },
          e(View, { style: S.sigImageSlot }, SIGNATURE_DATA_URI ? e(Image, { src: SIGNATURE_DATA_URI, style: { height: 32 } }) : null),
          e(View, { style: S.sigLine }),
          e(Text, { style: S.sigName }, cfg.LENDER_NAME.toUpperCase()),
          e(Text, { style: S.sigRole }, "Lender")
        ),
        e(View, { style: S.sigBox },
          e(View, { style: S.sigImageSlot }),
          e(View, { style: S.sigLine }),
          e(Text, { style: S.sigName }, (b.name || "").toUpperCase()),
          e(Text, { style: S.sigRole }, "Borrower")
        )
      ),
      footerBlock(cfg, dateStr)
    )
  );
}

async function renderSoaPdf(cfg, loanRow, bank, payments, schedule) {
  const { renderToBuffer } = await pdfKit();
  return renderToBuffer(await buildSoaPdf(cfg, loanRow, bank, payments, schedule));
}
async function renderAgreementPdf(cfg, loanRow, bank) {
  const { renderToBuffer } = await pdfKit();
  return renderToBuffer(await buildAgreementPdf(cfg, loanRow, bank));
}

module.exports = { renderSoaPdf, renderAgreementPdf };
