import threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright

ROOT = "/home/claude/reycredit-next/public"
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers(); self.wfile.write(b'{"result":null}')
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(H, directory=ROOT)); port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{port}/index.html"
fails = 0
def check(label, cond):
    global fails
    print(("PASS " if cond else "FAIL ") + label)
    if not cond: fails += 1

OPEN = """(nb) => { window.SELECTED = {borrowerName:'Test', loanName:'L', balance:5275, monthlyAmort:2500, nextBillDetails: nb}; window.SELECTED_ROW = 5; openPaymentDialog();
  return {month: document.getElementById('pm-month').value, year: document.getElementById('pm-year').value, amount: document.getElementById('pm-amount').value,
          chips: document.getElementById('pm-choices').style.display !== 'none'}; }"""
split = {"month":"October 2026","bill":2500,"overdueSeparate":2775,"overdueMonth":"September 2026","mergesOn":"September 20, 2026"}
plain = {"month":"October 2026","bill":5275,"overdueSeparate":0,"overdueMonth":""}

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args=["--no-sandbox"])
    page = b.new_page(viewport={"width": 390, "height": 800}); page.goto(URL)
    r = page.evaluate(OPEN, split)
    check("overdue pending: amount is the full overdue (2,775.00)", r["amount"] == "2775.00")
    check("...for the overdue month (September 2026)", r["month"] == "September" and r["year"] == "2026")
    check("...with the Overdue / Next payment choice shown", r["chips"])
    page.click("#pm-choices [data-pm-month='October 2026']")
    check("tapping Next payment switches to October 2,500.00", page.evaluate("() => [pm_m=document.getElementById('pm-month').value, document.getElementById('pm-amount').value].join()") == "October,2500.00")
    page.click("#pm-choices [data-pm-month='September 2026']")
    check("tapping Overdue switches back", page.evaluate("() => document.getElementById('pm-amount').value") == "2775.00")
    r = page.evaluate(OPEN, plain)
    check("merged bill: prefill the total, no choice shown", r["amount"] == "5275.00" and r["month"] == "October" and not r["chips"])
    b.close()
httpd.shutdown()
print("all passed" if not fails else f"{fails} failed")
raise SystemExit(1 if fails else 0)
