import threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright
ROOT = "/home/claude/reycredit-next/public"
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers(); self.wfile.write(b'{"result":null}')
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(H, directory=ROOT)); port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
fails = 0
def check(label, cond):
    global fails
    print(("PASS " if cond else "FAIL ") + label)
    if not cond: fails += 1

def stub(page, name, result):
    page.evaluate("""([name, result]) => { Object.defineProperty(window.google.script, 'run', { configurable: true, get: function() { var h = { withSuccessHandler: function(f){ this.ok = f; return this; }, withFailureHandler: function(f){ return this; } };
      h[name] = function(){ var f = this.ok; setTimeout(function(){ f(result); }, 0); }; return h; } }); }""", [name, result])

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args=["--no-sandbox"])
    page = b.new_page(viewport={"width": 1100, "height": 900}); errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(f"http://127.0.0.1:{port}/index.html")
    page.wait_for_timeout(300)
    html = page.content()
    check("the new-borrower form has no editable password and no hard-coded 1234", page.evaluate("() => { var e = document.getElementById('nb-password'); return !!e && e.disabled && e.value.indexOf('1234') < 0; }") and "'1234'" not in page.evaluate("() => saveNewBorrower.toString() + clearNewForm.toString()"))
    # sign in while locked shows the lock message
    stub(page, "validateLogin", {"success": False, "locked": True, "msg": "Too many wrong attempts. Try again in 12 minutes, or use Forgot password."})
    page.fill("#in-email", "a@x.com"); page.fill("#in-pass", "x"); page.click("#btn-signin"); page.wait_for_timeout(200)
    check("a locked account sees the lock message", "Try again in 12 minutes" in page.inner_text("#auth-alert"))
    stub(page, "validateLogin", {"success": False})
    page.click("#btn-signin"); page.wait_for_timeout(200)
    check("a plain wrong password keeps the normal message", "don't match" in page.inner_text("#auth-alert"))
    # weak password card
    check("Data health has the weak-passwords card", page.evaluate("() => !!document.getElementById('weak-run') && !!document.getElementById('weak-body')"))
    page.evaluate("() => { document.getElementById('stab-data').classList.remove('hidden'); }")
    stub(page, "auditWeakPasswords", {"success": True, "count": 2, "total": 9, "users": [{"email": "a@x.com", "name": "Ally"}, {"email": "v@x.com", "name": "Venah"}]})
    page.evaluate("() => document.getElementById('weak-run').click()"); page.wait_for_timeout(300)
    t = page.inner_text("#weak-body")
    check("it lists borrowers still on 1234", "2 borrowers still use 1234" in t and "Ally" in t and "v@x.com" in t)
    stub(page, "resetWeakPasswords", {"success": True, "changed": 2, "emailed": 1, "failed": ["v@x.com"]})
    page.evaluate("() => document.getElementById('weak-apply').click()"); page.wait_for_timeout(300)
    t = page.inner_text("#weak-body")
    check("after replacing it reports who was emailed and who failed", "2 PINs replaced" in t and "1 emailed" in t and "v@x.com" in t)
    stub(page, "auditWeakPasswords", {"success": True, "count": 0, "total": 9, "users": []})
    page.evaluate("() => document.getElementById('weak-run').click()"); page.wait_for_timeout(300)
    check("none left shows the all-clear", "None found" in page.inner_text("#weak-body"))
    # new borrower success shows the PIN once
    page.evaluate("() => { window.__shown = null; var o = window.showAlert; window.showAlert = function(id, t, m){ if (id === 'nb-alert') window.__shown = m; return o.apply(this, arguments); }; }")
    check("no JavaScript errors", errs == [])
    if errs: print(errs)
    b.close()
httpd.shutdown()
print("all passed" if not fails else f"{fails} failed")
raise SystemExit(1 if fails else 0)
