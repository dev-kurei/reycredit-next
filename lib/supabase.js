/**
 * Server-only Supabase client using the SERVICE ROLE key, which bypasses
 * Row Level Security. This file must never be imported by client-side code —
 * everything in /app/api/** runs on the server, so that is naturally enforced
 * as long as the anon key (not this one) is what you'd use in a browser.
 */
const { createClient } = require("@supabase/supabase-js");

let _client = null;
function db() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. Add them with `vercel env add`.");
  }
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

module.exports = { db };
