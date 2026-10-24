/**
 * The lender's signature as a base64 data URI (embedded so the PDF renderer
 * never has to fetch it over the network).
 *
 * The signature is NOT stored in the repository, because the repo is public.
 * It is read from, in this order:
 *   1. the LENDER_SIGNATURE_DATA_URI environment variable (set it in Vercel
 *      under Settings > Environment Variables), then
 *   2. a local file, lib/assets/signature.local.js (git-ignored; used on your
 *      own computer and for tests).
 * If neither exists the agreement is produced with a blank signature line.
 */
let value = process.env.LENDER_SIGNATURE_DATA_URI || "";
if (!value) {
  try { value = require("./signature.local"); } catch (e) { value = ""; }
}
module.exports = typeof value === "string" ? value.trim() : "";
