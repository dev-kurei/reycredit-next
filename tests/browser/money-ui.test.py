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

MONEY = {"principalPaid":6000,"interestPaid":1500,"feePaid":0,"penaltiesCharged":75,"penaltiesPaid":75,"lateFeesCharged":200,"lateFeesPaid":200,"chargesOwed":0,"instalmentsLeft":2500,"overpaid":0}
DETAIL = {"borrowerName":"Ally","email":"a@x.com","loanName":"Cash","status":"UPDATED","balance":2500,"amountPaid":7775,"monthlyAmort":2500,"remaining":1,"startDate":"July 20, 2026","originalAmount":8000,"totalPayable":10000,"totalInterest":2000,"processingFee":0,"lateFee":200,"lateFeeFromISO":"","monthlyRate":"5%","terms":4,
  "bankMonthly":2300,"bankFee":100,"bankTerms":4,"nextBillDetails":None,"money":MONEY,"profit":{"hasBankCost":True,"bankMonthly":2300,"bankFee":100,"bankTerms":4,"principal":8000,"interestMarkup":800,"interestIncome":2000,"feeIncome":300,"bankInterest":1200,"bankFeeCharged":100,"bankTotal":9300,"bankPaid":7000,"bankLeft":2300,"borrowerTotal":10300,"expectedProfit":1000,"marginPct":9.7,"extrasCollected":275,"extrasOwed":0,"collected":7775,"netCash":775,"stillToCollect":2500,"projectedNet":975},"history":[{"month":"October 2026","amount":2775,"date":"10/12/2026","receiptNo":"R3","toCharges":275,"toInstalments":2500}]}
REPORT = {"success":True,"collectionRate":{"month":"October 2026","collected":0,"target":0,"rate":0,"cashIn":0,"lastMonth":0,"lastMonthToDate":0,"dayOfMonth":15,"daysInMonth":31,"monthInProgress":True,"pace":None,"growth":0},
  "totalReceivable":0,"trend":[{"label":"Oct 26","amount":0}],"aging":{"days30":[],"days60":[],"days90":[]},"agingTotal":0,"bankBreakdown":[],"projected":[],"topPayers":[],"delinquents":[],"allBorrowers":[],
  "profit":{"markup":800,"interestIncome":2000,"feeIncome":300,"bankInterest":1200,"bankFees":100,"loans":1,"missing":1,"expected":700,"extras":275,"bankTotal":9300,"bankPaid":7000,"collected":7775,"netCash":775,"projectedNet":975,"list":[{"name":"Ally","loan":"Cash","borrowerTotal":10000,"bankTotal":9300,"expectedProfit":700,"extrasCollected":275,"netCash":775,"projectedNet":975}]},
  "income":{"interest":3000,"fee":0,"principal":12000,"penaltiesCharged":75,"penaltiesPaid":75,"lateFeesCharged":200,"lateFeesPaid":200,"chargesPaid":275,"chargesOwed":0,
    "byMonth":[{"label":"Sep 26","interest":0,"charges":0},{"label":"Oct 26","interest":1500,"charges":275}],"loans":[{"name":"Ally","loan":"Cash","interestPaid":1500,"penaltiesPaid":75,"penaltiesCharged":75,"lateFeesPaid":200,"lateFeesCharged":200,"chargesOwed":0}]}}

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args=["--no-sandbox"])
    page = b.new_page(viewport={"width": 390, "height": 900}); errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(f"http://127.0.0.1:{port}/index.html")
    page.evaluate("(d) => { renderDetail(d); }", DETAIL)
    txt = page.inner_text("#loan-detail")
    check("loan page shows 'Where the payments went'", "Where the payments went" in txt)
    check("...principal 6,000.00 and interest 1,500.00", "6,000.00" in txt and "1,500.00" in txt)
    check("...penalty and late fee collected", "75.00" in txt and "200.00" in txt)
    check("loan page shows Your profit with expected profit and net cash", "Your profit" in txt and "1,000.00" in txt and "775.00" in txt and "Private" in txt)
    page.evaluate("(d) => { var x = JSON.parse(JSON.stringify(d)); x.profit = {hasBankCost:false}; renderDetail(x); }", DETAIL)
    i = [txt.find(x) for x in ["Principal (amount borrowed)", "Bank interest", "Bank processing fee", "Your interest patong", "Your processing fee"]]
    check("loan page lists principal, bank interest, bank fee, your patong, your fee - in that order", all(x >= 0 for x in i) and i == sorted(i))
    check("without a bank cost, it asks you to add it", "Add bank cost" in page.inner_text("#loan-detail"))
    page.evaluate("(d) => { renderDetail(d); }", DETAIL)
    check("payment history shows the 2,500 / 275 split", "275.00 penalty/fees" in txt)
    page.evaluate("(r) => { renderReports(r); }", REPORT)
    rt = page.inner_text("#reports-body")
    check("Reports has the Interest, penalties & fees card", "Interest, penalties & fees" in rt and "Interest collected" in rt and "Penalties collected" in rt)
    check("...with the per-borrower row", "Ally" in rt and "3,000.00" in rt)
    check("Reports has Your real profit with the loan row and the missing-cost note", "Your real profit" in rt and "Net cash so far" in rt and "1 active loan has no bank cost" in rt)
    check("Reports shows your processing fees and the bank's separately", "your processing fees" in rt and "bank processing fees" in rt)
    page.evaluate("() => { openEditLoan && 0; }")
    check("the new-loan and add-loan forms have the private bank-cost fields; editing a loan does not", page.evaluate("() => ['nb','al'].every(function(p){ return ['bankmonthly','bankfee','bankterms'].every(function(k){ return !!document.getElementById(p+'-'+k); }); }) && !document.getElementById('ed-bankmonthly')"))
    page.evaluate("(d) => { window.SELECTED = d; window.SELECTED_ROW = 7; renderDetail(d); openBankCost(); }", DETAIL)
    check("Edit on the profit card opens the bank-cost dialog with the saved values", page.evaluate("() => document.getElementById('dlg-bankcost').classList.contains('open') && document.getElementById('bc-monthly').value === '2300' && document.getElementById('bc-fee').value === '100' && document.getElementById('bc-terms').value === '4'"))
    page.evaluate("() => { document.getElementById('bc-monthly').value = '1500'; var sent = null; Object.defineProperty(window.google.script, 'run', { get: function() { return { withSuccessHandler: function(f){ window.__ok = f; return this; }, withFailureHandler: function(){ return this; }, setBankCost: function(){ window.__args = Array.prototype.slice.call(arguments); } }; } }); document.getElementById('bc-save').click(); }")
    check("Save sends only the loan id and the three bank-cost numbers", page.evaluate("() => JSON.stringify(window.__args)") == "[7,1500,100,4]")
    check("editing a loan's readLoanForm leaves bank cost undefined (never zeroes it)", page.evaluate("() => { var f = readLoanForm('ed'); return f.bankMonthly === undefined && f.bankFee === undefined && f.bankTerms === undefined; }"))
    check("readLoanForm reads them", page.evaluate("() => { document.getElementById('nb-bankmonthly').value='1750'; document.getElementById('nb-bankfee').value='50'; document.getElementById('nb-bankterms').value='3'; var f = readLoanForm('nb'); return f.bankMonthly===1750 && f.bankFee===50 && f.bankTerms===3; }"))
    page.evaluate("(d) => { var x = JSON.parse(JSON.stringify(d)); x.originalAmount = 70000; x.terms = 9; x.bankMonthly = 0; x.bankFee = 0; x.bankTerms = 0; window.SELECTED = x; window.SELECTED_ROW = 7; openBankCost(); }", DETAIL)
    page.select_option("#bc-mode", "rate")
    page.fill("#bc-rate", "0.79"); page.fill("#bc-terms", "12")
    calc = page.inner_text("#bc-calc")
    check("percent mode: 0.79% x 12 on 70,000 shows 6,386.33 a month, 76,635.96 total, 6,635.96 interest", "6,386.33" in calc and "76,635.96" in calc and "6,635.96" in calc)
    check("percent mode hides the monthly box and shows the rate box", page.evaluate("() => document.getElementById('bc-monthly-wrap').style.display === 'none' && document.getElementById('bc-rate-wrap').style.display === ''"))
    page.evaluate("() => { Object.defineProperty(window.google.script, 'run', { get: function() { return { withSuccessHandler: function(f){ window.__ok = f; return this; }, withFailureHandler: function(){ return this; }, setBankCost: function(){ window.__args = Array.prototype.slice.call(arguments); } }; } }); window.__args = null; var b = document.getElementById('bc-save'); b.disabled = false; b.click(); }")
    check("saving in percent mode sends the worked-out monthly", page.evaluate("() => JSON.stringify(window.__args)") == "[7,6386.33,0,12]")
    page.select_option("#bc-mode", "monthly"); page.fill("#bc-monthly", "6386.33")
    check("monthly mode shows the about-% (0.79%)", "About 0.79% per month" in page.inner_text("#bc-calc"))
    page.evaluate("() => { document.getElementById('nb-principal').value='70000'; document.getElementById('nb-terms').value='9'; document.getElementById('nb-bankmonthly').value='0'; document.getElementById('nb-bankrate').value='0.79'; document.getElementById('nb-bankterms').value='12'; }")
    check("new-loan form: % with monthly 0 works out 6,386.33", page.evaluate("() => readLoanForm('nb').bankMonthly") == 6386.33)
    check("new-loan form: bank months default to the loan's terms when blank", page.evaluate("() => { document.getElementById('nb-bankterms').value=''; return readLoanForm('nb').bankMonthly; }") == round(70000*(1+0.0079*9)/9, 2))
    check("new-loan form: a typed monthly payment wins over the %", page.evaluate("() => { document.getElementById('nb-bankmonthly').value='5000'; return readLoanForm('nb').bankMonthly; }") == 5000)
    check("no JavaScript errors", errs == [])
    if errs: print(errs)
    b.close()
httpd.shutdown()
print("all passed" if not fails else f"{fails} failed")
raise SystemExit(1 if fails else 0)
