/**
 * Sends mail through Resend (resend.com) — a transactional email API that
 * replaces the earlier Gmail SMTP setup.
 *
 * Why the switch: Gmail via an App Password caps out around 500/day, sends
 * from a @gmail.com address even once the business has its own domain, and
 * is more prone to being flagged as bulk mail. Resend's free tier gives
 * 3,000 emails/month (100/day) from a verified @reycredits.com address,
 * which is both more headroom than this portfolio needs and more credible
 * in a borrower's inbox.
 *
 * This does not touch how the business receives mail. A mailbox like Zoho
 * Mail's admin@reycredits.com keeps working exactly as before — it uses MX
 * records, while Resend verifies the domain through separate SPF/DKIM
 * records. Sending and receiving run side by side on the same domain
 * without conflict.
 *
 * Env vars needed:
 *   RESEND_API_KEY      from resend.com -> API Keys
 *   RESEND_FROM_EMAIL   an address on a domain verified in Resend,
 *                        e.g. billing@reycredits.com
 */
const { Resend } = require("resend");

let _client = null;
function client() {
  if (_client) return _client;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set. Add it with `vercel env add`.");
  _client = new Resend(key);
  return _client;
}

/** Resend wants attachment content as a Buffer or a base64 string, not raw text. */
function toResendAttachments(attachments) {
  if (!attachments || !attachments.length) return undefined;
  return attachments.map((a) => ({
    filename: a.filename,
    content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : Buffer.from(String(a.content), "utf8").toString("base64"),
  }));
}

/** to/cc: string or array. attachments: [{filename, content, contentType}]. Returns {success, msg} — never throws. */
async function sendMail({ to, cc, subject, html, fromName, attachments }) {
  try {
    const fromEmail = process.env.RESEND_FROM_EMAIL;
    if (!fromEmail) throw new Error("RESEND_FROM_EMAIL is not set. Add it with `vercel env add`.");
    const { data, error } = await client().emails.send({
      from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
      to: Array.isArray(to) ? to : [to],
      cc: cc ? (Array.isArray(cc) ? cc : [cc]) : undefined,
      subject, html,
      attachments: toResendAttachments(attachments),
    });
    if (error) return { success: false, msg: error.message || String(error) };
    return { success: true, id: data?.id || "" };
  } catch (e) {
    return { success: false, msg: e.message || String(e) };
  }
}

module.exports = { sendMail };
