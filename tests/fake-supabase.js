/* Minimal in-memory fake of the Supabase query builder, just enough surface
   to exercise lib/functions.js end-to-end without a real database. */
function makeFakeDb(tables) {
  function table(name) {
    let rows = tables[name];
    let filters = [];
    let selectCols = "*";
    let joinBorrowers = false, joinLoans = false;
    let mode = "select";
    let payload = null;
    let countMode = null;
    let limitN = null;

    function apply(rowsIn) {
      let out = rowsIn;
      for (const f of filters) {
        if (f.op === "eq") out = out.filter(r => r[f.col] === f.val);
        if (f.op === "ilike") out = out.filter(r => (r[f.col]||"").toLowerCase() === String(f.val).toLowerCase());
        if (f.op === "in") out = out.filter(r => f.val.includes(r[f.col]));
        if (f.op === "gte") out = out.filter(r => r[f.col] >= f.val);
      }
      return out;
    }
    function hydrate(r) {
      const o = { ...r };
      if (joinBorrowers && name === "loans") o.borrowers = tables.borrowers.find(b => b.id === r.borrower_id) || null;
      if (joinLoans && name === "borrowers") o.loans = tables.loans.filter(l => l.borrower_id === r.id);
      return o;
    }

    const api = {
      select(cols, opts) {
        selectCols = cols;
        if (opts && opts.count === "exact") countMode = true;
        if (typeof cols === "string" && cols.includes("borrowers(")) joinBorrowers = true;
        if (typeof cols === "string" && cols.includes("loans(")) joinLoans = true;
        return api;
      },
      eq(col, val) { filters.push({ op: "eq", col, val }); return api; },
      ilike(col, val) { filters.push({ op: "ilike", col, val }); return api; },
      in(col, val) { filters.push({ op: "in", col, val }); return api; },
      gte(col, val) { filters.push({ op: "gte", col, val }); return api; },
      order() { return api; },
      limit(n) { limitN = n; return api; },
      insert(obj) { mode = "insert"; payload = obj; return api; },
      update(obj) { mode = "update"; payload = obj; return api; },
      delete() { mode = "delete"; return api; },
      upsert(objs) { mode = "upsert"; payload = objs; return api; },
      maybeSingle() {
        const out = apply(rows).map(hydrate);
        return Promise.resolve({ data: out[0] || null, error: null });
      },
      single() {
        if (mode === "insert") {
          const id = (rows.reduce((m, r) => Math.max(m, r.id || 0), 0)) + 1;
          const row = { id, ...payload };
          rows.push(row);
          return Promise.resolve({ data: hydrate(row), error: null });
        }
        const out = apply(rows).map(hydrate);
        return Promise.resolve({ data: out[0] || null, error: null });
      },
      then(resolve) {
        // terminal await point for plain selects/updates/deletes/inserts without .single()/.maybeSingle()
        if (mode === "insert") {
          const items = Array.isArray(payload) ? payload : [payload];
          const inserted = items.map((p) => {
            const id = (rows.reduce((m, r) => Math.max(m, r.id || 0), 0)) + 1;
            const row = { id, ...(name === "email_log" ? { created_at: new Date().toISOString() } : {}), ...p };
            rows.push(row);
            return row;
          });
          return resolve({ data: inserted, error: null });
        }
        if (mode === "update") {
          const targets = apply(rows);
          targets.forEach(r => Object.assign(r, payload));
          return resolve({ data: targets, error: null, count: targets.length });
        }
        if (mode === "delete") {
          const targets = apply(rows);
          tables[name] = rows.filter(r => !targets.includes(r));
          return resolve({ data: targets, error: null });
        }
        if (mode === "upsert") {
          for (const p of payload) {
            const existing = rows.find(r => r.key === p.key || r.email === p.email);
            if (existing) Object.assign(existing, p);
            else rows.push({ id: rows.length + 1, ...p });
          }
          return resolve({ data: payload, error: null });
        }
        let out = apply(rows).map(hydrate);
        if (limitN != null) out = out.slice(0, limitN);
        return resolve({ data: out, error: null, count: countMode ? out.length : undefined });
      },
    };
    return api;
  }
  return { from: table };
}
module.exports = { makeFakeDb };
