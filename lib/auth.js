/**
 * Session handling.
 *
 * The old Apps Script version had NO real server-side authorization: any
 * function exposed to the client (including deleteBorrower, addNewBorrower,
 * saveConfig — anything) could be called by whoever loaded the public web
 * app URL, because google.script.run calls aren't checked against a role on
 * the server. The UI simply hid the buttons. This migration is the moment to
 * close that: every mutating or admin-only RPC now checks a signed session
 * cookie server-side, not just what the browser chooses to show.
 */
const bcrypt = require("bcryptjs");
const { SignJWT, jwtVerify } = require("jose");
const { cookies } = require("next/headers");

const COOKIE_NAME = "rc_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14; // 14 days

function secretKey() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET is not set (or too short). Set a random 32+ char string with `vercel env add`.");
  return new TextEncoder().encode(s);
}

async function createSessionCookie(user) {
  const token = await new SignJWT({ email: user.email, role: user.role, sub: user.id })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secretKey());
  cookies().set(COOKIE_NAME, token, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: MAX_AGE_SECONDS,
  });
}

function clearSessionCookie() {
  cookies().set(COOKIE_NAME, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
}

/** Returns {email, role, sub} or null. Never throws. */
async function currentSession() {
  const token = cookies().get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return payload;
  } catch {
    return null;
  }
}

async function requireRole(role) {
  const s = await currentSession();
  if (!s) return { ok: false, code: 401, msg: "Not signed in." };
  if (role && s.role !== role) return { ok: false, code: 403, msg: "Not allowed." };
  return { ok: true, session: s };
}

function hashPassword(plain) { return bcrypt.hashSync(plain, 10); }
function verifyPassword(plain, hash) { return bcrypt.compareSync(plain, hash || ""); }

module.exports = { createSessionCookie, clearSessionCookie, currentSession, requireRole, hashPassword, verifyPassword };
