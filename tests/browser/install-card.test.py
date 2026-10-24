import sys, threading, http.server, socketserver, functools, os
from playwright.sync_api import sync_playwright

ROOT = "/home/claude/reycredit-next/public"
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers(); self.wfile.write(b'{"result":null}')
Handler = functools.partial(H, directory=ROOT)
httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler); port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{port}/index.html"

fails = 0
def check(label, cond):
    global fails
    print(("PASS " if cond else "FAIL ") + label)
    if not cond: fails += 1

FIRE = """() => { window.__prompted = 0; const e = new Event('beforeinstallprompt'); e.prompt = () => { window.__prompted++; }; e.userChoice = Promise.resolve({outcome:'accepted'}); window.dispatchEvent(e); }"""
vis = lambda page: page.evaluate("() => document.getElementById('install-banner').classList.contains('show')")

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args=["--no-sandbox"])

    # 1. Android/desktop Chrome: installable
    ctx = b.new_context(viewport={"width": 390, "height": 800}); page = ctx.new_page(); page.goto(URL)
    check("hidden before the browser says the app is installable", not vis(page))
    page.evaluate(FIRE)
    check("card appears once the browser offers the install", vis(page))
    check("card shows the Install button", page.evaluate("() => document.getElementById('ib-action').style.display !== 'none'"))
    page.click("#ib-action")
    page.wait_for_timeout(100)
    check("tapping Install opens the browser's install dialog", page.evaluate("() => window.__prompted") == 1)
    check("card goes away after the choice", not vis(page))

    # 2. Not now: hidden for this visit, back on the next
    page.evaluate(FIRE); check("card is back when offered again", vis(page))
    page.click("text=Not now"); check("'Not now' hides it", not vis(page))
    page.reload(); page.evaluate(FIRE)
    check("same browser session: stays hidden after 'Not now'", not vis(page))
    ctx.close()
    ctx2 = b.new_context(viewport={"width": 390, "height": 800}); page2 = ctx2.new_page(); page2.goto(URL); page2.evaluate(FIRE)
    check("a new visit shows it again", vis(page2))

    # 3. Installed: never again
    page2.evaluate("() => window.dispatchEvent(new Event('appinstalled'))")
    check("hidden after the app is installed", not vis(page2))
    page2.reload()
    check("still hidden on the next load", not vis(page2))
    page2.evaluate(FIRE)
    check("...but if the browser offers install again (app was removed) it returns", vis(page2))
    ctx2.close()

    # 4. Running as the installed app
    ctx3 = b.new_context(viewport={"width": 390, "height": 800}); ctx3.add_init_script("Object.defineProperty(navigator,'standalone',{get:()=>true})")
    page3 = ctx3.new_page(); page3.goto(URL); page3.evaluate(FIRE)
    check("never shown inside the installed app", not vis(page3)); ctx3.close()

    # 5. iPhone Safari: no install event exists, so the card explains Add to Home Screen
    ios = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    ctx4 = b.new_context(user_agent=ios, viewport={"width": 390, "height": 800}); page4 = ctx4.new_page(); page4.goto(URL)
    check("iPhone: card shows without any browser event", vis(page4))
    check("iPhone: explains Add to Home Screen", "Add to Home Screen" in page4.inner_text("#ib-text"))
    check("iPhone: no Install button (it would do nothing)", page4.evaluate("() => document.getElementById('ib-action').style.display") == "none")
    page4.click("text=Already installed"); check("iPhone: 'Already installed' stops it for good", not vis(page4))
    page4.reload(); check("iPhone: ...including on the next visit", not vis(page4)); ctx4.close()

    # 6. Inside Messenger/Facebook
    fb = "Mozilla/5.0 (Linux; Android 13; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/440.0]"
    ctx5 = b.new_context(user_agent=fb, viewport={"width": 390, "height": 800}); page5 = ctx5.new_page(); page5.goto(URL)
    check("in-app browser: tells them to open it in Chrome", vis(page5) and "Open in Chrome" in page5.inner_text("#ib-text"))
    check("in-app browser: no useless Install button", page5.evaluate("() => document.getElementById('ib-action').style.display") == "none"); ctx5.close()

    # 7. Desktop Chrome with no install support: nothing
    ctx6 = b.new_context(); page6 = ctx6.new_page(); page6.goto(URL)
    check("an ordinary browser without install support sees nothing", not vis(page6))

    # 8. Not shown to the admin console
    page6.evaluate(FIRE); check("shown on the sign-in page", vis(page6))
    page6.evaluate("() => showScreen('admin')"); check("hidden in the admin console", not vis(page6))
    page6.evaluate("() => showScreen('portal')"); check("shown again in the borrower portal", vis(page6))
    page6.screenshot(path="/tmp/install-card.png")
    ctx6.close(); b.close()
print("\nFAILED: %d" % fails if fails else "\nALL PASS")
sys.exit(1 if fails else 0)
