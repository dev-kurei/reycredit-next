/**
 * Scheduled work, triggered by Vercel Cron (see vercel.json). This replaces the
 * Apps Script time-based triggers — there is no "install triggers" step any more;
 * the schedule lives in vercel.json and switches on with the deploy.
 *
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` on cron calls. Anyone else
 * hitting this URL is refused.
 *
 * One job (?job=all) runs everything, because the free plan limits how many cron
 * entries and how often; individual jobs stay callable for manual runs.
 */
const functions = require("../../../lib/functions");

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  return !!secret && (req.headers.get("authorization") || "") === `Bearer ${secret}`;
}

export async function GET(req) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const job = params.get("job") || "all";
  // Once per loan per day by default, so Vercel's Run button, a retry, or the schedule
  // firing after a manual run can't send a borrower the same email twice.
  // Add &force=1 to deliberately send again.
  const opts = { skipAlreadySentToday: params.get("force") !== "1" };
  const out = { job };
  try {
    if (job === "due-reminders" || job === "all") out.reminders = await functions.runDueReminders(opts);
    if (job === "monthly-statements" || job === "all") out.statements = await functions.runMonthlyStatements(opts);
    if (!out.reminders && !out.statements) return Response.json({ error: "Unknown job. Use ?job=all|due-reminders|monthly-statements" }, { status: 400 });
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: e.message || String(e) }, { status: 500 });
  }
}
