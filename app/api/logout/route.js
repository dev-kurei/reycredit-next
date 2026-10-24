const { clearSessionCookie } = require("../../../lib/auth");
export async function POST() {
  clearSessionCookie();
  return Response.json({ success: true });
}
