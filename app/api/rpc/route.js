/**
 * Single RPC endpoint. The existing front-end (public/index.html, carried
 * over unchanged) calls the server the way it always did — by function name
 * with positional arguments — so this one route dispatches to the same
 * function names the old Code.gs exposed, now backed by Supabase.
 *
 * Authorization: every function is classified below as public, borrower,
 * or admin. This is real server-side enforcement — the old Apps Script
 * version had none (anyone who found the web app URL could call ANY
 * function, including deleteBorrower, by name). A borrower session can only
 * reach the handful of functions that make sense for a borrower to call
 * for THEIR OWN email; everything else requires an admin session.
 */
const functions = require("../../../lib/functions");
const { currentSession, createSessionCookie } = require("../../../lib/auth");

export const maxDuration = 60;

const PUBLIC_FNS = new Set(["validateLogin", "resetPasswordToDefault"]);
// Borrower-callable functions take the caller's own email as their first
// argument; we overwrite that argument with the session's email server-side
// so a signed-in borrower can never pass someone else's address.
const BORROWER_FNS = new Set([
  "getBorrowerData", "getBorrowerPersonalDetails", "getPortalInfo",
  "getBillingScheduleByEmail", "changeUserPassword",
]);

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "Bad request." }, { status: 400 }); }
  const { fn, args } = body || {};

  // Own, callable properties only. A plain `!functions[fn]` lets inherited keys such as
  // "__proto__", "constructor" and "toString" through, since every object has them.
  if (!fn || typeof fn !== "string" || !Object.prototype.hasOwnProperty.call(functions, fn) || typeof functions[fn] !== "function") {
    return Response.json({ error: `Unknown function "${fn}".` }, { status: 404 });
  }

  if (fn === "validateLogin") {
    // Special-cased: this is the one function that establishes the session
    // cookie. Everything downstream trusts the cookie, not whatever the
    // client claims about itself.
    try {
      const result = await functions.validateLogin(...(Array.isArray(args) ? args : []));
      if (result.success) await createSessionCookie({ email: result.email, role: result.role, id: result.email });
      return Response.json({ result });
    } catch (e) {
      return Response.json({ error: e.message || String(e) }, { status: 500 });
    }
  }

  const session = await currentSession();

  if (PUBLIC_FNS.has(fn)) {
    // no session required
  } else if (BORROWER_FNS.has(fn)) {
    if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });
    const callArgs = Array.isArray(args) ? [...args] : [];
    // getPortalInfo takes no email argument; the others take email first.
    if (fn !== "getPortalInfo") callArgs[0] = session.email;
    try {
      const result = await functions[fn](...callArgs);
      return Response.json({ result });
    } catch (e) {
      return Response.json({ error: e.message || String(e) }, { status: 500 });
    }
  } else {
    if (!session) return Response.json({ error: "Not signed in." }, { status: 401 });
    if (session.role !== "ADMIN") return Response.json({ error: "Not allowed." }, { status: 403 });
  }

  try {
    const result = await functions[fn](...(Array.isArray(args) ? args : []));
    return Response.json({ result });
  } catch (e) {
    return Response.json({ error: e.message || String(e) }, { status: 500 });
  }
}
