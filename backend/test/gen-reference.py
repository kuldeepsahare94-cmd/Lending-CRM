"""Independent reference schedules for the loan engine tests.
Uses Python's Decimal (not the engine's BigInt method) so the two can be compared.
Run: python3 gen-reference.py > fixtures/reference-schedules.json"""
import json, calendar
from decimal import Decimal as D, getcontext, ROUND_HALF_UP
getcontext().prec = 80
PPY = {'monthly': 12, 'quarterly': 4}
STEP = {'monthly': 1, 'quarterly': 3}

def q(x):  # round half up to whole paise
    return int(x.quantize(D('1'), rounding=ROUND_HALF_UP))

def due(start, k, freq):
    y, m, d = map(int, start.split('-'))
    idx = (m - 1) + k * STEP[freq]
    yy, mm = y + idx // 12, idx % 12 + 1
    return '%04d-%02d-%02d' % (yy, mm, min(d, calendar.monthrange(yy, mm)[1]))

def schedule(P, rate_pct, n, freq, method, typ, start):
    P = D(P); i = D(str(rate_pct)) / 100 / PPY[freq]
    rows = []
    if typ == 'maturity':
        it = q(P * D(str(rate_pct)) / 100 * n / PPY[freq])
        return [dict(seq=1, due_date=due(start, n, freq), principal_paise=int(P), interest_paise=it)]
    if method == 'flat':
        tot = q(P * D(str(rate_pct)) / 100 * n / PPY[freq])
        bi = tot // n; bp = int(P) // n if typ == 'emi' else 0
        il, pl = tot, int(P)
        for k in range(1, n + 1):
            last = k == n
            it = il if last else bi; pr = pl if last else bp
            rows.append(dict(seq=k, due_date=due(start, k, freq), principal_paise=pr, interest_paise=it)); il -= it; pl -= pr
        return rows
    emi = q(P / n) if i == 0 else q(P * i * (1 + i) ** n / ((1 + i) ** n - 1))
    open_ = int(P)
    for k in range(1, n + 1):
        last = k == n
        it = q(D(open_) * i)
        pr = open_ if last else (emi - it if typ == 'emi' else 0)
        rows.append(dict(seq=k, due_date=due(start, k, freq), principal_paise=pr, interest_paise=it)); open_ -= pr
    return rows

cases = [
  ('reducing EMI, month-end start', 10000000, 12, 12, 'monthly', 'reducing', 'emi', '2026-01-31'),
  ('reducing EMI, leap-day start, 36 months', 50000000, 14.5, 36, 'monthly', 'reducing', 'emi', '2024-02-29'),
  ('flat EMI, 18 months', 25000000, 10.5, 18, 'monthly', 'flat', 'emi', '2026-03-15'),
  ('zero interest with remainder', 10000001, 0, 10, 'monthly', 'reducing', 'emi', '2026-05-01'),
  ('odd amount, 7 months', 1234567, 9.75, 7, 'monthly', 'reducing', 'emi', '2026-06-10'),
  ('balloon, reducing', 200000000, 11, 12, 'monthly', 'reducing', 'balloon', '2026-08-01'),
  ('balloon, flat, quarterly', 100000000, 9, 8, 'quarterly', 'flat', 'balloon', '2026-01-01'),
  ('one-time maturity', 10000000, 12, 6, 'monthly', 'flat', 'maturity', '2026-02-28'),
]
out = []
for name, P, r, n, f, m, t, s in cases:
    out.append(dict(name=name, params=dict(principal_paise=P, rate_e4=int(D(str(r)) * 10000), tenure=n, frequency=f,
        interest_method=m, repayment_type=t, start_date=s), expected=schedule(P, r, n, f, m, t, s)))
print(json.dumps(out, indent=1))
