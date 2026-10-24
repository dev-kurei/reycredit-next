/*  ============================================================
    REY CREDIT — Financial engine (pure functions, no I/O)
    ------------------------------------------------------------
    Ported from the Apps Script version with every bug fix intact:
      - rounding residue absorbed only up to 1 peso/term, never
        smeared across the schedule when the data itself disagrees
        (the Venah P. incident)
      - balance = total charged (incl. penalties) − total paid,
        never the naive total-payable − amount-paid subtraction
        (the Rey / SSD Manggahan incident)
      - remaining counts unsettled scheduled cycles only, excluding
        extension (past-term) rows
      - nextBill returns null once the ledger is actually clear,
        never a stale positive figure from an old shortfall
        (the John A. incident)
      - credit score: recency-weighted (12-month half-life),
        amount-weighted, judged against each cycle's OWN charge
        (not inflated by carried-over arrears), staleness-flagged,
        trend-aware
      - "closed" is always derived from the live ledger, never a
        stored flag — a borrower can't improve standing just by
        taking out another loan, and a settled loan can't keep
        counting as active exposure
    All monetary values are plain JS numbers, rounded to centavos
    with round2(). Dates are plain Date objects at local midnight.
    ============================================================ */

const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

const SETTLED_THRESHOLD = 1;          // under one peso is rounding dust, not a debt
const GRACE_DAYS = 3;                 // settling within a few days still counts as on time
const RECENCY_HALFLIFE_MONTHS = 12;   // how fast old behaviour stops counting
const STALE_AFTER_MONTHS = 6;         // beyond this with no billing, the record is dated
const THIN_FILE_CYCLES = 3;           // below this, there is not enough history to judge

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function day0(d) {
  const x = d instanceof Date ? new Date(d.getTime()) : new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
/**
 * Today's calendar date in the Philippines. Vercel runs in UTC, so a bare
 * new Date() would read as the previous day for the first eight hours of every
 * Manila morning — enough to flip a loan between due-soon and overdue. Every
 * date-driven decision in the engine goes through this.
 */
function today() {
  const manila = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
  manila.setHours(0, 0, 0, 0);
  return manila;
}

function monthsBetween(a, b) {
  return (a.getFullYear() - b.getFullYear()) * 12 + (a.getMonth() - b.getMonth());
}
function daysBetween(a, b) { return Math.ceil((a - b) / 86400000); }

function fmtDate(d, style) {
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  if (style === "MM/dd/yyyy") return `${pad(x.getMonth() + 1)}/${pad(x.getDate())}/${x.getFullYear()}`;
  if (style === "yyyy-MM-dd") return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  if (style === "MMMM dd, yyyy") return `${MONTHS[x.getMonth()]} ${pad(x.getDate())}, ${x.getFullYear()}`;
  if (style === "MMMM yyyy") return `${MONTHS[x.getMonth()]} ${x.getFullYear()}`;
  return x.toDateString();
}

/** "August 2026" -> {year, month, key}. Null when unusable. */
function monthKeyFrom(label) {
  if (!label) return null;
  const parts = String(label).trim().toLowerCase().split(" ");
  if (parts.length < 2) return null;
  const idx = MONTHS.findIndex((m) => m.toLowerCase() === parts[0]);
  const year = parseInt(parts[1], 10);
  if (idx < 0 || !year) return null;
  return { year, month: idx, key: `${year}-${String(idx + 1).padStart(2, "0")}`, label: `${MONTHS[idx]} ${year}` };
}
function sameCycle(label, date) {
  const mk = monthKeyFrom(label);
  return !!mk && mk.year === date.getFullYear() && mk.month === date.getMonth();
}

/* ============================================================
   BILLING SCHEDULE
   loan  = { startDate, totalPayable, terms, monthlyAmort, processingFee,
             bank: { statementDay, dueDay, sameMonth } | null, dueDay }
   payments = [{ month, amount, date (Date), receiptNo, method }]
   ============================================================ */

function firstDueDate(startDate, bank, fallbackDueDay) {
  const sd = startDate instanceof Date ? startDate : new Date(startDate);
  if (bank) {
    const day = sd.getDate();
    if (bank.sameMonth) {
      return day0(new Date(sd.getFullYear(), sd.getMonth() + (day <= bank.statementDay ? 0 : 1), bank.dueDay));
    }
    if (bank.statementDay === 1 && bank.dueDay === 1) {
      return day0(new Date(sd.getFullYear(), sd.getMonth() + 1, day));
    }
    return day0(new Date(sd.getFullYear(), sd.getMonth() + (day <= bank.statementDay ? 1 : 2), bank.dueDay));
  }
  return day0(new Date(sd.getFullYear(), sd.getMonth() + 1, Number(fallbackDueDay) || 1));
}

/** Cycles due on/after this date use the due-date penalty rule. Override with env PENALTY_FIXED_FROM. */
function defaultPenaltyFrom() {
  const v = process.env.PENALTY_FIXED_FROM || "2026-10-10";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(2026, 9, 10);
}

function statementDateFor(dueDate, bank) {
  if (!bank) return dueDate;
  return day0(new Date(dueDate.getFullYear(), dueDate.getMonth() - (bank.sameMonth ? 0 : 1), bank.statementDay));
}

/**
 * Builds the month-by-month ledger for one loan. This is the single source
 * of truth: balance, status, next-bill and credit scoring are all derived
 * from its output, never from a separately stored total.
 */
function buildSchedule(loan, payments, penaltyRatePct) {
  const terms = Number(loan.terms) || 0;
  const amort = Number(loan.monthlyAmort) || 0;
  const fee = Number(loan.processingFee) || 0;
  const payable = Number(loan.totalPayable) || 0;
  const bank = loan.bank || null;
  const penalty = (Number(penaltyRatePct) || 0) / 100;
  // Flat late payment fee, charged once for every cycle not settled by its due date. It is
  // stipulated per loan (it is printed in that loan's agreement), and an optional start date
  // keeps cycles that fell due before it was agreed from being charged retroactively.
  const lateFeeAmt = Math.max(0, round2(loan.lateFee));
  const lateFeeFrom = loan.lateFeeFrom ? day0(loan.lateFeeFrom) : null;
  // The percentage penalty is charged ON THE DUE DATE on the FULL bill of that cycle whenever it was
  // not fully paid by then (a part payment, even an advance one, does not shrink it), and a later
  // payment does not take it back. Cycles that fell due before PENALTY_FIXED_FROM keep the
  // old rule (penalty on what is still unpaid today) once they were settled, so history does not move.
  // loan.penaltyFrom: a Date = that cutoff; null = new rule for every cycle; unset = default.
  const penaltyFrom = loan.penaltyFrom === null ? null : day0(loan.penaltyFrom || defaultPenaltyFrom());
  const now = today();

  let firstDue = firstDueDate(loan.startDate, bank, loan.dueDay);

  // If a payment is labelled for a month earlier than the bank rule implies,
  // the first bill really was earlier — otherwise that payment has nowhere
  // to land and quietly distorts the ledger.
  let earliest = null;
  for (const p of payments) {
    const pk = monthKeyFrom(p.month);
    if (!pk) continue;
    const candidate = day0(new Date(pk.year, pk.month, firstDue.getDate()));
    if (!earliest || candidate < earliest) earliest = candidate;
  }
  if (earliest && earliest < firstDue) firstDue = earliest;

  // Rounding residue: 12 x 2,333.33 = 27,999.96 against a stated total of
  // 28,000.00. The gap is absorbed in the final scheduled month — but ONLY
  // when it is centavo-sized. A larger gap means the terms/amortization/total
  // simply do not agree (a data-entry mistake), and smearing it across the
  // schedule can produce a negative "bill". That case is flagged, not patched.
  const scheduled = round2(amort * terms + fee);
  const gap = terms > 0 ? round2(payable - scheduled) : 0;
  const roundingLimit = round2(terms * SETTLED_THRESHOLD);
  const termsMismatch = Math.abs(gap) > roundingLimit;
  const residue = termsMismatch ? 0 : gap;
  const impliedAmort = terms > 0 ? round2((payable - fee) / terms) : 0;

  const schedule = [];
  let carry = 0;
  let charged = 0;   // everything billed so far on schedule: instalments, fees, penalties, late fees

  /** Money received on or before a date, whichever month it was labelled for (undated = on time). */
  function receivedBy(date) {
    let t = 0;
    for (const p of payments) if (!p.date || day0(p.date) <= date) t += Number(p.amount) || 0;
    return round2(t);
  }

  function paidFor(dueDate, isFirstMonth) {
    let total = 0, onTime = 0, payDate = null, receipt = "";
    for (const p of payments) {
      let matched = sameCycle(p.month, dueDate);
      if (!matched && isFirstMonth && !monthKeyFrom(p.month)) {
        const pd = p.date ? day0(p.date) : null;
        if (pd && pd <= firstDue) matched = true;
      }
      if (!matched) continue;
      total += Number(p.amount) || 0;
      if (!p.date || day0(p.date) <= dueDate) onTime += Number(p.amount) || 0;   // undated money counts as on time
      payDate = p.date || payDate;
      receipt = p.receiptNo || receipt;
    }
    return { paid: round2(total), paidOnTime: round2(onTime), payDate, receipt };
  }

  function pushRow(dueDate, bill, amortPart, feePart, carryIn, isExt) {
    const hit = paidFor(dueDate, !isExt && schedule.length === 0);
    let out = round2(bill - hit.paid);
    if (out > 0 && out < SETTLED_THRESHOLD) out = 0;

    let pen = 0, nextCarry = 0, lateFee = 0;
    const past = dueDate < now;

    // Money received by the due date goes to the oldest debt first. What is left of the older
    // debt is the arrears; this cycle's own amount is billed on top of it.
    let dueArrears = round2(charged - receivedBy(dueDate));
    if (dueArrears < SETTLED_THRESHOLD) dueArrears = 0;
    // What was still unpaid on the due date itself (earlier penalties and late fees included).
    let dueUnpaid = round2(charged + amortPart + feePart - receivedBy(dueDate));
    if (dueUnpaid < SETTLED_THRESHOLD) dueUnpaid = 0;
    // Old rule only for cycles that were already settled before the new rule took effect (their
    // history stays as it was). A cycle still unpaid once the rule is in force follows the new rule,
    // otherwise paying the overdue amount shown (penalty included) would make the penalty vanish
    // and the money paid for it would turn into a credit against next month's bill.
    const legacyRule = !!(penaltyFrom && dueDate < penaltyFrom &&
      (now < penaltyFrom || round2(charged + amortPart + feePart - receivedBy(new Date(penaltyFrom.getFullYear(), penaltyFrom.getMonth(), penaltyFrom.getDate() - 1))) < SETTLED_THRESHOLD));
    // The whole bill of the cycle, however much of it was paid before the due date.
    const dueBill = round2(amortPart + feePart + dueArrears);

    if (past) {
      if (legacyRule) {
        if (out > 0) pen = round2(out * penalty);               // old rule: on what is still unpaid today
      } else if (dueUnpaid > 0) {
        pen = round2(dueBill * penalty);                        // on the FULL bill, charged once, on the due date
      }
      // Late = not fully received by the due date, even if it was settled afterwards. The fee is
      // flat, so it does not compound with the percentage penalty.
      if (lateFeeAmt > 0 && (!lateFeeFrom || dueDate >= lateFeeFrom) && dueUnpaid > 0) lateFee = lateFeeAmt;
      nextCarry = round2(out + pen + lateFee);                  // a payment beyond the bill is a credit that flows forward
    } else if (out < 0) {
      nextCarry = out; // credit flows forward
      // future months never push a balance forward — they are not billed yet
    }
    charged = round2(charged + amortPart + feePart + pen + lateFee);

    const monthsAgo = Math.max(0, monthsBetween(now, dueDate));
    const recency = Math.pow(0.5, monthsAgo / RECENCY_HALFLIFE_MONTHS);

    const row = {
      month: `${MONTHS[dueDate.getMonth()]} ${dueDate.getFullYear()}`,
      dueDate: fmtDate(dueDate, "MM/dd/yyyy"),
      dueDateObj: new Date(dueDate.getTime()),
      isPast: past,
      bill: Math.max(0, round2(bill)),
      amort: round2(amortPart),
      fee: round2(feePart),
      carryIn: round2(carryIn),
      paid: hit.paid,
      payDate: hit.payDate ? fmtDate(hit.payDate, "MM/dd/yyyy") : "",
      payDateObj: hit.payDate || null,
      receiptNo: hit.receipt,
      outstanding: out,
      penalty: pen,
      lateFee,
      carryOut: round2(nextCarry),
      isExtension: !!isExt,
      monthsAgo, recency,
    };
    let status;
    if (out <= 0 && (hit.paid > 0 || carryIn < 0)) status = "PAID";
    else if (hit.paid > 0) status = "PARTIAL";
    else if (past) status = isExt ? "PAST_TERM" : "OVERDUE";
    else if (carryIn > 0 || isExt) status = "FOR_PAYMENT";
    else status = "PENDING";
    row.status = status;

    schedule.push(row);
    carry = nextCarry;
  }

  for (let m = 0; m < terms; m++) {
    const due = day0(new Date(firstDue.getFullYear(), firstDue.getMonth() + m, firstDue.getDate()));
    const last = m === terms - 1;
    const thisAmort = Math.max(0, last ? round2(amort + residue) : amort);
    pushRow(due, thisAmort + (m === 0 ? fee : 0) + carry, thisAmort, m === 0 ? fee : 0, carry, false);
  }

  // Extension months: past-term penalty accrual, only once the original
  // term has lapsed and a balance remains.
  const lastTermDue = day0(new Date(firstDue.getFullYear(), firstDue.getMonth() + terms - 1, firstDue.getDate()));
  if (lastTermDue < now && round2(carry) > 0) {
    let ext = 0, upcomingAdded = false;
    while (round2(carry) > 0 && ext < 24) {
      const extDue = day0(new Date(firstDue.getFullYear(), firstDue.getMonth() + terms + ext, firstDue.getDate()));
      if (extDue > now) { if (upcomingAdded) break; upcomingAdded = true; }
      const before = carry;
      pushRow(extDue, round2(carry), 0, 0, before, true);
      const last = schedule[schedule.length - 1];
      ext++;
      if (last.paid >= last.bill && last.carryOut <= 0) break;
    }
  }

  return { schedule, bank, firstDue, termsMismatch, expectedPayable: scheduled, statedPayable: payable, impliedAmort };
}

/**
 * What the borrower still owes from cycles that have already elapsed.
 *
 * The last elapsed cycle's carry-over is the starting point, but money already paid toward the
 * cycle that is due next is applied to that carry first (oldest debt first). Without this, a
 * borrower who paid P1,000 of a P1,060.15 carry-over on the due date itself -- a cycle that is
 * not "past" until tomorrow -- was still shown as owing the full P1,060.15.
 */
function arrearsAt(schedule, i) {
  let owed = Math.max(0, schedule[i].carryOut || 0);
  const next = schedule[i + 1];
  if (owed > 0 && next && !next.isPast && next.carryIn > 0) owed = Math.max(0, round2(owed - next.paid));
  return owed;
}
function owedToday(schedule) {
  for (let i = schedule.length - 1; i >= 0; i--) {
    if (!schedule[i].isPast) continue;
    const owed = arrearsAt(schedule, i);
    return owed < SETTLED_THRESHOLD ? 0 : owed;
  }
  return 0;
}
function oldestUnsettled(schedule) {
  if (owedToday(schedule) <= 0) return null;
  for (const r of schedule) if (r.isPast && r.outstanding > 0) return r;
  return null;
}

/**
 * Total balance: everything charged (own amount + fee + any penalty actually
 * applied) minus everything paid. Carry-over is excluded from "charged" since
 * it is the same money counted again. This is the one true balance figure —
 * it can never disagree with the schedule, because it comes from nothing else.
 */
function balanceFrom(schedule) {
  let charged = 0, paid = 0;
  for (const r of schedule) {
    charged += round2(r.amort + r.fee) + (r.penalty || 0) + (r.lateFee || 0);
    paid += r.paid;
  }
  let owed = round2(charged - paid);
  if (owed > 0 && owed < SETTLED_THRESHOLD) owed = 0;
  return Math.max(0, owed);
}

/** Months still to settle — scheduled cycles only, extensions excluded. */
function remainingFrom(schedule) {
  let count = 0;
  for (const r of schedule) { if (r.isExtension) continue; if (r.outstanding > 0) count++; }
  return count;
}

/**
 * The next amount due. Returns null once the ledger is genuinely clear —
 * an individual cycle's stale "outstanding" must never be quoted after a
 * later overpayment has already cleared the running balance.
 */
function nextBillFrom(built) {
  if (balanceFrom(built.schedule) <= 0) return null;
  const s = built.schedule;
  let r = s.find((x) => !x.isPast && x.outstanding > 0);
  if (!r) { for (let i = s.length - 1; i >= 0; i--) { if (s[i].outstanding > 0) { r = s[i]; break; } } }
  if (!r) return null;

  const own = round2(r.amort + r.fee);
  const carryIn = r.carryIn > 0 ? r.carryIn : 0;
  // Merged bill: money paid settles the carried-over (oldest) part first.
  const carryOldestFirst = Math.max(0, Math.min(carryIn, round2(carryIn - r.paid)));
  // While the overdue is shown separately, money paid settles THIS cycle's own amount first, so
  // paying the "Next payment" shown on screen actually clears it. The total owed is identical
  // either way; only how it is split between the two lines differs.
  const ownLeftSplit = Math.max(0, round2(own - r.paid));
  const carryLeftSplit = Math.max(0, round2(carryIn - Math.max(0, round2(r.paid - own))));

  // Until the statement for this cycle is generated, the overdue amount is shown as its own line
  // and is NOT added into the next payment. From the statement date on it is billed together.
  const statementDate = statementDateFor(r.dueDateObj, built.bank);
  const split = !r.isPast && own > 0 && carryLeftSplit >= SETTLED_THRESHOLD && today() < statementDate;

  // What has been charged on top of the unpaid instalments so far (for the breakdown line).
  let penaltyCharged = 0, lateFeesCharged = 0;
  for (const x of s) { if (x.isPast) { penaltyCharged += x.penalty || 0; lateFeesCharged += x.lateFee || 0; } }

  // The overdue amount sits on the previous (already elapsed) row, so a payment meant for it is
  // recorded against that month. Used to pre-select the month in the Record payment dialog.
  const idx = s.indexOf(r);
  const prev = idx > 0 ? s[idx - 1] : null;

  return {
    overdueMonth: split && prev ? prev.month : "",
    bill: split ? ownLeftSplit : r.outstanding,
    totalDue: r.outstanding,
    overdueSeparate: split ? carryLeftSplit : 0,       // shown on its own line, not inside `bill`
    overdueAmount: split ? carryLeftSplit : carryOldestFirst,   // overdue carried into this cycle, merged or not
    penaltyCharged: round2(penaltyCharged), lateFeesCharged: round2(lateFeesCharged),
    mergesOn: split ? fmtDate(statementDate, "MMMM dd, yyyy") : "",
    grossBill: r.bill, baseAmort: r.amort, feeAmount: r.fee,
    carryAmount: split ? 0 : r.carryIn, paidSoFar: r.paid, hasCarry: !split && r.carryIn > 0, hasFee: r.fee > 0,
    isOverdue: r.isPast, isPastTerm: r.isExtension, dueDate: r.dueDate, dueDateObj: r.dueDateObj, month: r.month,
  };
}


/**
 * Where the money went. Every payment is recorded as received in full, but it is applied to the
 * penalties and late fees that have already been charged FIRST and only the rest reduces the
 * instalments. So paying 2,775 against a 2,500 bill that carries 275 of penalty and fees pays off
 * those 275 and reduces the loan by 2,500, never more. Charges are the lender's income, not a
 * reduction of what the borrower still owes on the loan.
 *
 * The instalments are then split into principal, interest and processing fee in the same
 * proportion as they make up the loan (the usual convention for a flat-rate loan).
 *
 * loan: { principal, totalInterest, processingFee }.  Returns plain numbers; all sums reconcile
 * with balanceFrom(): instalmentsLeft + chargesOwed - overpaid = balance.
 */
function moneyBreakdown(loan, built, payments) {
  const schedule = built.schedule;
  const fee = Math.max(0, Number(loan.processingFee) || 0);
  const pool = round2(schedule.reduce((a, r) => a + r.amort + r.fee, 0));   // all instalments, fee included
  // Charges, available to be paid from the day after their due date (money received ON the due date is on time).
  const charges = [];
  for (const r of schedule) {
    const when = new Date(r.dueDateObj.getFullYear(), r.dueDateObj.getMonth(), r.dueDateObj.getDate() + 1);
    if (r.penalty > 0) charges.push({ kind: "penalty", due: when, left: r.penalty });
    if (r.lateFee > 0) charges.push({ kind: "lateFee", due: when, left: r.lateFee });
  }
  const chargedPenalty = round2(charges.filter((c) => c.kind === "penalty").reduce((a, c) => a + c.left, 0));
  const chargedLate = round2(charges.filter((c) => c.kind === "lateFee").reduce((a, c) => a + c.left, 0));
  const paidTo = { penalty: 0, lateFee: 0 };

  const events = payments.map((p, i) => ({ i, amount: Number(p.amount) || 0, date: p.date ? day0(p.date) : null, receiptNo: p.receiptNo || "", month: p.month }))
    .filter((e) => e.amount > 0)
    .sort((a, b) => (a.date ? a.date.getTime() : -Infinity) - (b.date ? b.date.getTime() : -Infinity) || a.i - b.i);

  let instalmentsPaid = 0, overpaid = 0;
  const applied = [];   // per payment: how it was split
  const payCharges = (e, rest, onlyAccrued) => {
    let got = 0;
    for (const kind of ["penalty", "lateFee"]) {
      for (const c of charges) {
        if (c.kind !== kind || c.left <= 0 || rest <= 0) continue;
        if (onlyAccrued && !(e.date && c.due <= e.date)) continue;
        const take = Math.min(c.left, rest);
        c.left = round2(c.left - take); rest = round2(rest - take); got = round2(got + take);
        paidTo[kind] = round2(paidTo[kind] + take);
      }
    }
    return { got, rest };
  };
  for (const e of events) {
    let { got, rest } = payCharges(e, e.amount, true);              // 1. charges that already exist
    const room = Math.max(0, round2(pool - instalmentsPaid));
    const toInst = Math.min(rest, room);                            // 2. the instalments
    instalmentsPaid = round2(instalmentsPaid + toInst); rest = round2(rest - toInst);
    if (rest > 0) { const r2 = payCharges(e, rest, false); got = round2(got + r2.got); rest = r2.rest; }   // 3. paid ahead of a charge
    overpaid = round2(overpaid + rest);
    applied.push({ index: e.i, receiptNo: e.receiptNo, month: e.month, amount: e.amount, date: e.date, toCharges: got, toInstalments: toInst, extra: rest });
  }

  const owedPenalty = round2(chargedPenalty - paidTo.penalty), owedLate = round2(chargedLate - paidTo.lateFee);
  const iTot = (Number(loan.principal) || 0) + (Number(loan.totalInterest) || 0);
  const iShare = iTot > 0 ? (Number(loan.totalInterest) || 0) / iTot : 0;
  const wFee = pool > 0 ? Math.min(1, fee / pool) : 0;
  const wInt = (1 - wFee) * iShare;
  const feePaid = round2(instalmentsPaid * wFee), interestPaid = round2(instalmentsPaid * wInt);
  const principalPaid = round2(instalmentsPaid - feePaid - interestPaid);
  return {
    instalmentsPaid, instalmentsLeft: Math.max(0, round2(pool - instalmentsPaid)),
    principalPaid, interestPaid, feePaid,
    penaltiesCharged: chargedPenalty, penaltiesPaid: paidTo.penalty, penaltiesOwed: Math.max(0, owedPenalty),
    lateFeesCharged: chargedLate, lateFeesPaid: paidTo.lateFee, lateFeesOwed: Math.max(0, owedLate),
    chargesPaid: round2(paidTo.penalty + paidTo.lateFee), chargesOwed: Math.max(0, round2(owedPenalty + owedLate)),
    overpaid, applied, interestRatio: wInt, feeRatio: wFee,
  };
}


/**
 * What the loan really earns you after the bank / credit card has been paid. Admin-only: nothing in
 * here may reach a borrower. The money you lend out comes from the card and the card is repaid
 * through the monthly bank payments, so the principal passes straight through and
 *   net cash so far  = collected from the borrower - paid to the bank so far
 *   expected profit  = what the borrower pays on the instalments - everything you pay the bank
 * Penalties and late fees are extra profit on top (the bank charges nothing for them).
 * The bank is assumed to bill on the same monthly cycle as the borrower's due dates.
 */
function profitFrom(loan, built, money, balance, paid) {
  const monthly = Math.max(0, Number(loan.bankMonthly) || 0);
  const oneTime = Math.max(0, Number(loan.bankFee) || 0);
  if (!(monthly > 0 || oneTime > 0)) return { hasBankCost: false };
  const terms = Math.max(1, Number(loan.bankTerms) || Number(loan.terms) || 1);
  const bankTotal = round2(monthly * terms + oneTime);
  // The bank keeps billing for ITS terms (say 12 months) even when the borrower was given fewer (say 9),
  // so its bills are counted from the first due date, not from the borrower's schedule rows.
  const first = built.firstDue;
  let billed = 0;
  for (let k = 0; k < terms; k++) {
    if (day0(new Date(first.getFullYear(), first.getMonth() + k, first.getDate())) < today()) billed++; else break;
  }
  const started = loan.startDate && day0(loan.startDate) <= today();
  const bankPaid = round2(monthly * billed + (started ? oneTime : 0));
  const instalments = money ? round2(money.instalmentsPaid + money.instalmentsLeft) : round2(Number(loan.totalPayable) || 0);
  const expectedProfit = round2(instalments - bankTotal);
  const extras = money ? money.chargesPaid : 0, extrasOwed = money ? money.chargesOwed : 0;
  const netCash = round2(paid - bankPaid);
  // The two kinds of fee and interest are kept apart: what you charge the borrower, and what the bank charges you.
  const principal = Math.max(0, Number(loan.principal) || 0);
  const interestIncome = round2(Number(loan.totalInterest) || 0);
  const feeIncome = round2(Number(loan.processingFee) || 0);                 // your own processing fee, charged to the borrower
  const bankInterest = round2(monthly * terms - principal);                  // what you pay the bank beyond the amount borrowed
  return {
    hasBankCost: true, borrowerTerms: Number(loan.terms) || 0, bankMonthsAfterBorrower: Math.max(0, terms - (Number(loan.terms) || 0)), principal, interestIncome, feeIncome, bankInterest, bankFeeCharged: oneTime,
    interestMarkup: round2(interestIncome - bankInterest),   // your own "patong": the interest you charge less the bank's interest bankMonthly: monthly, bankFee: oneTime, bankTerms: terms,
    bankTotal, bankPaid, bankLeft: Math.max(0, round2(bankTotal - bankPaid)),
    borrowerTotal: instalments, expectedProfit,
    marginPct: instalments > 0 ? Math.round((expectedProfit / instalments) * 1000) / 10 : 0,
    extrasCollected: extras, extrasOwed,
    collected: round2(paid), netCash,
    stillToCollect: round2(balance),
    projectedNet: round2(netCash + balance - Math.max(0, round2(bankTotal - bankPaid))),   // if every peso still owed is collected
  };
}

/** Status label, derived purely from the ledger. */
function statusFrom(balance, built) {
  if (Number(balance) <= 0) return "FULLY_PAID";
  const s = built.schedule, now = today();
  if (!s.length) return "IN_PROGRESS";

  let lastPast = -1;
  s.forEach((r, i) => { if (r.isPast) lastPast = i; });
  let owed = lastPast >= 0 ? arrearsAt(s, lastPast) : 0;
  if (owed < SETTLED_THRESHOLD) owed = 0;

  if (owed <= 0) {
    const next = s.find((r) => !r.isPast && r.outstanding > 0);
    if (!next) return "UPDATED";
    if (next === s[0] && next.paid === 0) {
      const stmt = statementDateFor(next.dueDateObj, built.bank);
      if (now < stmt) return "IN_PROGRESS";
    }
    if (daysBetween(next.dueDateObj, now) <= 5) return "DUE_SOON";
    return "FOR_PAYMENT";
  }

  if (s[lastPast].isExtension) return "DELINQUENT";
  let streak = 0;
  for (let k = lastPast; k >= 0 && s[k].isPast && (s[k].carryOut || 0) > 0; k--) streak++;
  if (streak >= 2) return "DELINQUENT";
  if (s[lastPast].paid > 0) return "LACKING_PAYMENT";
  return "OVERDUE";
}

const STATUS_LABEL = {
  FULLY_PAID: "🏆 FULLY PAID", DELINQUENT: "💀 DELINQUENT", PAST_TERM: "💀 PAST TERM",
  OVERDUE: "⚠️ OVERDUE", LACKING_PAYMENT: "📉 LACKING PAYMENT", PARTIAL: "📉 PARTIAL",
  DUE_SOON: "⏳ DUE SOON", UPDATED: "✅ UPDATED", PAID: "✅ PAID", FOR_PAYMENT: "💳 FOR PAYMENT",
  IN_PROGRESS: "💤 IN PROGRESS", PENDING: "⏳ PENDING",
};
function statusLabel(code) { return STATUS_LABEL[code] || code; }

/** Everything a loan detail view needs, computed fresh every time. */
function liveLoanFigures(loan, payments, penaltyRatePct) {
  const built = buildSchedule(loan, payments, penaltyRatePct);
  const balance = balanceFrom(built.schedule);
  const statusCode = statusFrom(balance, built);
  const remaining = balance <= 0 ? 0 : remainingFrom(built.schedule);
  const paid = round2(built.schedule.reduce((a, r) => a + r.paid, 0));
  const arrears = owedToday(built.schedule);
  const next = nextBillFrom(built);
  const money = moneyBreakdown(loan, built, payments);
  return {
    built, balance, profit: profitFrom(loan, built, money, balance, paid), status: statusCode, statusText: statusLabel(statusCode),
    remaining, paid, arrears, next, money,
    termsMismatch: built.termsMismatch, expectedPayable: built.expectedPayable, impliedAmort: built.impliedAmort,
  };
}

/* ============================================================
   CREDIT SCORING
   loans = [{ ...loan fields..., id }]  (closed is DERIVED, never read from here)
   paymentsByLoanId = Map(loanId -> payments[])
   ============================================================ */

const SCORE_WEIGHTS = { onTime: 40, lateness: 20, completeness: 15, standing: 15, history: 10 };
const SCORE_BANDS = [
  { min: 85, grade: "A", label: "Excellent", tone: "success" },
  { min: 70, grade: "B", label: "Good", tone: "success" },
  { min: 55, grade: "C", label: "Fair", tone: "warning" },
  { min: 40, grade: "D", label: "Weak", tone: "warning" },
  { min: 0, grade: "E", label: "High risk", tone: "danger" },
];
function scoreBand(score) { return SCORE_BANDS.find((b) => score >= b.min) || SCORE_BANDS[SCORE_BANDS.length - 1]; }
function punctuality(daysLate) {
  if (daysLate <= GRACE_DAYS) return 1;
  if (daysLate <= 15) return 0.5;
  if (daysLate <= 30) return 0.25;
  return 0;
}

function scoreBorrower(loans, paymentsByLoanId, penaltyRatePct) {
  const now = today();
  const cycles = [];
  let arrears = 0, monthlyLoad = 0, closedLoans = 0, activeLoans = 0;
  let firstBilled = null, lastBilled = null;
  const perLoan = [];

  for (const loan of loans) {
    const payments = paymentsByLoanId.get(loan.id) || [];
    const built = buildSchedule(loan, payments, penaltyRatePct);
    const closed = balanceFrom(built.schedule) <= 0;   // derived, not a stored flag
    if (closed) closedLoans++; else { activeLoans++; monthlyLoad += Number(loan.monthlyAmort) || 0; }
    const loanArrears = owedToday(built.schedule);
    arrears += loanArrears;

    let loanCycles = 0, loanOnTime = 0, loanLate = 0;
    for (const r of built.schedule) {
      if (!r.isPast) continue;
      if (!firstBilled || r.dueDateObj < firstBilled) firstBilled = r.dueDateObj;
      if (!lastBilled || r.dueDateObj > lastBilled) lastBilled = r.dueDateObj;

      const ownDue = round2(r.amort + r.fee);
      const keptUp = r.paid >= ownDue - 0.01;
      let daysLate;
      if (keptUp) daysLate = r.payDateObj ? Math.max(0, daysBetween(day0(r.payDateObj), r.dueDateObj)) : 0;
      else daysLate = Math.max(0, daysBetween(now, r.dueDateObj));

      const monthsAgo = Math.max(0, monthsBetween(now, r.dueDateObj));
      const recency = Math.pow(0.5, monthsAgo / RECENCY_HALFLIFE_MONTHS);
      const weight = recency * Math.max(ownDue, 1);
      const onTime = keptUp && daysLate <= GRACE_DAYS;

      cycles.push({ month: r.month, due: r.dueDate, bill: r.bill, ownDue, paid: r.paid,
        settled: r.outstanding <= 0, keptUp, daysLate, weight, onTime, partial: r.paid > 0 && !keptUp });
      loanCycles++; loanLate += daysLate; if (onTime) loanOnTime++;
    }

    perLoan.push({
      loan: loan.loanName, terms: loan.terms, amort: loan.monthlyAmort, balance: balanceFrom(built.schedule),
      closed, cycles: loanCycles, onTime: loanOnTime,
      avgDaysLate: loanCycles ? round2(loanLate / loanCycles) : 0,
      arrears: round2(loanArrears), onTimeRate: loanCycles ? Math.round((loanOnTime / loanCycles) * 100) : null,
    });
  }
  perLoan.sort((a, b) => (b.arrears - a.arrears) || ((a.onTimeRate ?? 0) - (b.onTimeRate ?? 0)));

  const n = cycles.length;
  if (!n) return { scored: false, reason: "No billed cycles yet", cycles: 0, arrears: round2(arrears), closedLoans, activeLoans, perLoan };

  const wTotal = cycles.reduce((a, c) => a + c.weight, 0) || 1;
  const fOnTime = (cycles.reduce((a, c) => a + punctuality(c.daysLate) * c.weight, 0) / wTotal) * 100;
  const avgLateWeighted = cycles.reduce((a, c) => a + c.daysLate * c.weight, 0) / wTotal;
  const avgLatePlain = cycles.reduce((a, c) => a + c.daysLate, 0) / n;
  const fLateness = Math.max(0, 100 - (avgLateWeighted / 30) * 100);
  const onTimeCount = cycles.filter((c) => c.onTime).length;
  const settledCount = cycles.filter((c) => c.keptUp).length;
  const fComplete = (cycles.reduce((a, c) => a + (c.keptUp ? c.weight : 0), 0) / wTotal) * 100;

  // Standing yardstick: real average monthly charge over the last 6 billed
  // months. Using the committed monthly load would let a borrower "improve"
  // standing merely by taking out another loan (a real bug we caught).
  const recentByMonthsAgo = {};
  for (const loan of loans) {
    const payments = paymentsByLoanId.get(loan.id) || [];
    const built = buildSchedule(loan, payments, penaltyRatePct);
    for (const r of built.schedule) {
      if (!r.isPast) continue;
      const ma = Math.max(0, monthsBetween(now, r.dueDateObj));
      if (ma > 11) continue;
      recentByMonthsAgo[ma] = (recentByMonthsAgo[ma] || 0) + round2(r.amort + r.fee);
    }
  }
  const monthKeys = Object.keys(recentByMonthsAgo).sort((a, b) => a - b).slice(0, 6);
  const billedAvg = monthKeys.length ? monthKeys.reduce((a, k) => a + recentByMonthsAgo[k], 0) / monthKeys.length : 0;
  const yardstick = billedAvg > 0 ? billedAvg : (cycles[n - 1].ownDue || cycles[n - 1].bill || 1);
  const fStanding = arrears <= 0 ? 100 : Math.max(0, 100 - (arrears / yardstick) * 50);

  const monthsOfHistory = firstBilled && lastBilled ? monthsBetween(lastBilled, firstBilled) + 1 : 0;
  const closedBonus = Math.min(30, closedLoans * 15);
  const fHistory = Math.min(100, (monthsOfHistory / 24) * 70 + closedBonus);

  const raw = (fOnTime * SCORE_WEIGHTS.onTime + fLateness * SCORE_WEIGHTS.lateness +
    fComplete * SCORE_WEIGHTS.completeness + fStanding * SCORE_WEIGHTS.standing +
    fHistory * SCORE_WEIGHTS.history) / 100;
  const score = Math.round(Math.max(0, Math.min(100, raw)));
  const band = scoreBand(score);

  const monthsSinceLast = lastBilled ? Math.max(0, monthsBetween(now, lastBilled)) : 0;
  const stale = monthsSinceLast > STALE_AFTER_MONTHS;
  const isThin = n < THIN_FILE_CYCLES || monthsOfHistory < THIN_FILE_CYCLES;

  let trend = null;
  if (n >= 6) {
    const half = Math.min(6, Math.floor(n / 2));
    const recent = cycles.slice(-half), earlier = cycles.slice(-half * 2, -half);
    if (earlier.length) {
      const rate = (arr) => (arr.reduce((a, c) => a + punctuality(c.daysLate), 0) / arr.length) * 100;
      const delta = Math.round(rate(recent) - rate(earlier));
      trend = {
        delta, direction: delta >= 10 ? "improving" : delta <= -10 ? "slipping" : "steady",
        recentOnTime: recent.filter((c) => c.onTime).length, recentCount: recent.length,
        earlierOnTime: earlier.filter((c) => c.onTime).length, earlierCount: earlier.length,
      };
    }
  }

  const reasons = [];
  if (fOnTime >= 95) reasons.push({ good: true, text: "Settles on time, every cycle" });
  else if (fOnTime >= 70) reasons.push({ good: true, text: `${onTimeCount} of ${n} cycles settled on time` });
  else reasons.push({ good: false, text: `Only ${onTimeCount} of ${n} cycles settled on time` });
  if (avgLateWeighted >= 1) reasons.push({ good: false, text: `Averages ${Math.round(avgLateWeighted)} days late` });
  if (settledCount < n) reasons.push({ good: false, text: `${n - settledCount} cycle${n - settledCount === 1 ? "" : "s"} left short` });
  if (arrears > 0) reasons.push({ good: false, text: `${peso(arrears)} in arrears right now` });
  else reasons.push({ good: true, text: "Nothing overdue today" });
  if (closedLoans > 0) reasons.push({ good: true, text: `${closedLoans} loan${closedLoans === 1 ? "" : "s"} paid off in full` });
  if (isThin) reasons.push({ good: false, text: `Short history — ${monthsOfHistory} month${monthsOfHistory === 1 ? "" : "s"} of payments across ${n} cycle${n === 1 ? "" : "s"}` });
  if (stale) reasons.push({ good: false, text: `Nothing billed for ${monthsSinceLast} months — this record is dated` });
  if (trend?.direction === "improving") reasons.push({ good: true, text: `Turning around — ${trend.recentOnTime} of the last ${trend.recentCount} cycles on time, against ${trend.earlierOnTime} of ${trend.earlierCount} before` });
  if (trend?.direction === "slipping") reasons.push({ good: false, text: `Slipping — only ${trend.recentOnTime} of the last ${trend.recentCount} cycles on time, against ${trend.earlierOnTime} of ${trend.earlierCount} before` });

  return {
    scored: true, thin: isThin, stale, monthsSinceLast, monthsOfHistory,
    lastBilled: lastBilled ? fmtDate(lastBilled, "MMMM yyyy") : "",
    firstBilled: firstBilled ? fmtDate(firstBilled, "MMMM yyyy") : "",
    score, grade: band.grade, label: band.label, tone: band.tone,
    cycles: n, onTimeCount, settledCount,
    avgDaysLate: round2(avgLatePlain), recentDaysLate: round2(avgLateWeighted),
    arrears: round2(arrears), monthlyLoad: round2(monthlyLoad), closedLoans, activeLoans,
    trend, perLoan,
    factors: [
      { key: "onTime", label: "Paid on time", value: Math.round(fOnTime), weight: SCORE_WEIGHTS.onTime },
      { key: "lateness", label: "How late, when late", value: Math.round(fLateness), weight: SCORE_WEIGHTS.lateness },
      { key: "completeness", label: "Paid in full", value: Math.round(fComplete), weight: SCORE_WEIGHTS.completeness },
      { key: "standing", label: "Standing today", value: Math.round(fStanding), weight: SCORE_WEIGHTS.standing },
      { key: "history", label: "Track record", value: Math.round(fHistory), weight: SCORE_WEIGHTS.history },
    ],
    reasons,
    recentCycles: cycles.slice(-12).reverse(),
  };
}

/* ============================================================
   LENDING GUIDE
   ============================================================ */
const LEND_FACTOR = { A: 1.5, B: 1.25, C: 1.0, D: 0.6, E: 0 };

function lendingGuide(loans, paymentsByLoanId, penaltyRatePct) {
  const sc = scoreBorrower(loans, paymentsByLoanId, penaltyRatePct);
  let exposure = 0, monthlyNow = 0;
  for (const loan of loans) {
    const payments = paymentsByLoanId.get(loan.id) || [];
    const built = buildSchedule(loan, payments, penaltyRatePct);
    const bal = balanceFrom(built.schedule);
    if (bal <= 0) continue;                 // settled loans carry nothing
    exposure += bal;
    monthlyNow += Number(loan.monthlyAmort) || 0;
  }

  let proven = 0;
  for (const loan of loans) {
    const payments = paymentsByLoanId.get(loan.id) || [];
    const built = buildSchedule(loan, payments, penaltyRatePct);
    let run = 0;
    for (const r of built.schedule) {
      if (!r.isPast) continue;
      if (r.outstanding <= 0) { run++; if (run >= 3) proven = Math.max(proven, r.amort); }
      else run = 0;
    }
  }
  if (!proven) proven = monthlyNow;

  const grade = sc.scored && !sc.thin ? sc.grade : null;
  const factor = grade ? LEND_FACTOR[grade] : 0.75;
  const ceiling = round2(proven * factor);
  const headroom = round2(Math.max(0, ceiling - monthlyNow));

  let verdict, tone, why;
  if (sc.arrears > 0) {
    verdict = "Settle arrears first"; tone = "danger";
    why = `There is ${peso(sc.arrears)} still overdue. Clear that before adding new exposure.`;
  } else if (grade === "E") {
    verdict = "Not recommended"; tone = "danger";
    why = `Repayment record is poor across ${sc.cycles} billed cycles.`;
  } else if (!sc.scored) {
    verdict = "No record yet"; tone = "";
    why = "No billing cycle has come due, so there is nothing to judge. Lend on your own read of the person.";
  } else if (sc.stale) {
    verdict = "Record is dated"; tone = "warning";
    why = `Nothing billed for ${sc.monthsSinceLast} months. The old record was ${(sc.label || "").toLowerCase()}, but it is no longer current — start small.`;
  } else if (sc.thin) {
    verdict = "Proceed carefully"; tone = "warning";
    why = `Only ${sc.cycles} billed cycle${sc.cycles === 1 ? "" : "s"} so far. Keep any new loan small until the pattern is clear.`;
  } else if (headroom <= 0) {
    verdict = "At capacity"; tone = "warning";
    why = `Already carrying ${peso(monthlyNow)} a month, which is at the ceiling their record supports.`;
  } else {
    verdict = "Room to lend"; tone = "success";
    why = `Has reliably serviced ${peso(proven)} a month. Grade ${grade} supports up to ${peso(ceiling)}.`;
  }

  return {
    scored: sc.scored, thin: !!sc.thin, stale: !!sc.stale,
    score: sc.score || 0, grade: sc.grade || "—",
    label: sc.scored ? (sc.thin ? "Building history" : sc.label) : "No billed cycles yet",
    tone: sc.scored && !sc.thin ? sc.tone : "",
    cycles: sc.cycles || 0, arrears: round2(sc.arrears || 0), avgDaysLate: sc.avgDaysLate || 0,
    activeLoans: sc.activeLoans || 0, closedLoans: sc.closedLoans || 0,
    exposure: round2(exposure), monthlyNow: round2(monthlyNow), proven: round2(proven),
    factor, ceiling, headroom, verdict, verdictTone: tone, why,
  };
}

/**
 * The "Late payment" paragraph of the loan agreement. One wording, used by the HTML and PDF
 * agreements, so what the borrower signs is exactly what the engine charges.
 */
function lateClauseText(penaltyPct, lateFee, lateFeeFromLabel) {
  const base = `Any payment not received on or before the due date incurs a penalty of ${penaltyPct}% per month on the overdue amount.`;
  if (!(Number(lateFee) > 0)) return base;
  return base + ` If an installment is not paid in full by its due date, the penalty is computed on the full amount billed for that due date (not only on the unpaid part), is charged once for that due date, and is not waived or reduced by a later payment, even a partial or advance one; the penalty and the late payment fee are charged in addition to, and do not reduce, the installment itself.` +
    ` In addition, a flat late payment fee of ${peso(lateFee)} is charged for each monthly installment that is not paid in full on or before its due date, even if it is paid afterwards` +
    (lateFeeFromLabel ? `, for installments falling due on or after ${lateFeeFromLabel}` : "") + "." +
    "\n\nOverdue amounts, together with their penalty and late payment fees, are itemized separately in the BORROWER's statements and become payable with the next installment when the Statement of Account for that installment is issued. A penalty or late payment fee that remains unpaid is added to the overdue amount and is included in the amount on which the next penalty is computed, as expressly stipulated by the parties." +
    "\n\nAcknowledgment of charges. The BORROWER acknowledges that the interest, the penalty and the late payment fee in this Agreement have been disclosed and explained, were freely agreed to, and form part of the total cost of the loan. If a court finds any such charge to be excessive, only the excess shall be reduced, and the rest of this Agreement remains valid and enforceable.";
}

function peso(n) { return "\u20B1" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

module.exports = {
  MONTHS, round2, day0, today, monthsBetween, daysBetween, fmtDate, monthKeyFrom, peso,
  buildSchedule, owedToday, oldestUnsettled, balanceFrom, moneyBreakdown, profitFrom, lateClauseText, remainingFrom, nextBillFrom,
  statusFrom, statusLabel, liveLoanFigures, scoreBorrower, lendingGuide,
  SETTLED_THRESHOLD, GRACE_DAYS, STALE_AFTER_MONTHS, THIN_FILE_CYCLES,
};
