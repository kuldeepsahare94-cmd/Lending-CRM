# iCRM Expense Management — API for the mobile app

This is everything a mobile app (or any other program) needs to work with
expenses in iCRM. The web screens of the CRM use exactly the same links, so
whatever the web can do, the app can do.

- All links start with your backend address, for example
  `https://your-crm-backend.onrender.com`. Below, only the part after it is written.
- Everything is JSON (`Content-Type: application/json`), except sending a bill
  as a file and getting a bill back.
- Amounts are plain numbers in the CRM's currency (`meta.currency`, normally INR).
  Two decimals at most.
- A date is a text like `2026-10-05`. A moment is an ISO text like
  `2026-10-05T14:42:08.574Z` (UTC).
- "Today" is the day in the CRM's own time zone (`meta.time_zone`, normally
  `Asia/Kolkata`). An expense cannot be dated after that day.

---

## 1. Signing in

```
POST /api/auth/login
{ "username": "ravi", "password": "…" }

200 → { "token": "eyJhbGciOi…", "user": { "id": 12, "username": "ravi", "full_name": "Ravi Kumar", "role_name": "Sales", "permissions": { … } } }
401 → { "error": "Invalid username or password" }
```

Keep the `token` and send it with every other call:

```
Authorization: Bearer eyJhbGciOi…
```

The token works for 7 days. When a call answers **401**, sign in again.

---

## 2. How answers look when something is wrong

Every refusal is JSON with an `error` text in plain English that can be shown
to the person as it is.

| Status | Meaning |
|---|---|
| 400 | Something in what was sent is wrong (the text says what) |
| 401 | Not signed in / the token is old — sign in again |
| 403 | This person may not do this. With `"off": true`: expense management is switched off for them |
| 404 | No such expense / claim / advance |
| 409 | It cannot be done **now** (already sent, already paid, changed by someone else…). With `"stale": true`: load it again and show it before trying once more |
| 413 | The bills are too large to send together — send them one at a time |
| 500 | A problem on the server — try again later |

---

## 3. Start: what the app needs to know

```
GET /api/expenses/meta
```

Ask this once after signing in (and again when the app comes back to the front).

```json
{
  "enabled": true,
  "available": true,
  "currency": "INR", "symbol": "₹",
  "today": "2026-10-05", "time_zone": "Asia/Kolkata", "server_time": "2026-10-05T14:42:08.574Z",
  "me": { "id": 12, "name": "Ravi Kumar", "is_finance": false, "has_team": false,
          "can": { "view": true, "create": true, "edit": true, "delete": true, "export": false } },
  "categories": [
    { "id": 2, "name": "Local travel (auto, cab, bus)", "kind": "amount",
      "max_per_expense": null, "max_per_day": null, "max_per_month": null,
      "receipt_above": 200, "note_required": false, "daily_rate": null },
    { "id": 1, "name": "Fuel (own vehicle, by km)", "kind": "mileage", … },
    { "id": 5, "name": "Daily allowance", "kind": "per_day", "daily_rate": 300, … }
  ],
  "vehicle_rates": [ { "id": 1, "name": "Two-wheeler", "rate_per_km": 4 }, { "id": 2, "name": "Four-wheeler", "rate_per_km": 10 } ],
  "rules": { "max_age_days": 60, "over_limit": "flag", "duplicate_check": true,
             "max_receipt_mb": 4, "max_receipts": 6, "receipt_types": ["image/jpeg","image/png","image/webp","application/pdf"],
             "max_claim_lines": 300, "advances": true, "adjust_advance": true, "approval_levels": 1 },
  "related_modules": [ { "module": "leads", "label": "Lead" }, { "module": "contacts", "label": "Contact" },
                       { "module": "accounts", "label": "Account" }, { "module": "opportunities", "label": "Deal" } ],
  "reports": [ { "name": "summary", "title": "Summary" }, … ],
  "bill_reading": "device",
  "multi_currency": true, "fx_rate_edit": true, "fx_tolerance": 5,
  "currencies": [ { "code": "INR", "name": "Indian Rupee", "symbol": "₹", "decimals": 2, "is_base": true, "rate": 1 },
                  { "code": "USD", "name": "US Dollar", "symbol": "$", "decimals": 2, "is_base": false, "rate": 83.333333 } ],
  "bank": { "on": true, "self_edit": true, "payout": null },
  "tally": false
}
```

- `bill_reading`: how a bill photo is read (section 4b): `off`, `device` (read
  the text on the phone and send the TEXT) or `ai` (send the photo).
- `currencies` (only with `multi_currency`): `rate` is what ONE unit of that
  currency is in the CRM currency (1 USD = ₹83.33). The first one is the CRM's own.
- `bank.on`: payments through the bank are used — show "Bank details" (section 9).

- When `available` is `false`, do not show expenses at all: the company has not
  switched it on, or this person's role has no permission. (Only `enabled`,
  `available` and `is_admin` come back then.)
- `categories` already carry **this person's** limits (a role can have its own).
  `null` means "no limit". `receipt_above: 0` means a bill is always needed;
  `null` means never.
- `kind` decides what to ask:
  - `amount` — ask the amount.
  - `mileage` — ask the vehicle (from `vehicle_rates`) and the km. The amount is km × rate; **the server works it out**.
  - `per_day` — ask the number of days (0.5 steps). The amount is days × `daily_rate`; the server works it out. (If `daily_rate` is `null`, ask the amount.)
- `rules.over_limit`: `flag` = an expense outside the rules is allowed and the
  approver is warned; `block` = a claim holding such an expense cannot be sent.

### The home screen figures

```
GET /api/expenses/summary
→ { "unclaimed": { "count": 4, "amount": 2057 }, "drafts": {…}, "returned": {…},
    "waiting_approval": { "count": 1, "amount": 2057 }, "waiting_payment": { "count": 0, "amount": 0 },
    "paid_this_month": 0, "spent_this_month": 2057, "advance_balance": 1000,
    "to_approve": { "count": 2, "claims": 1, "advances": 1, "amount": 2057 },
    "is_finance": false, "has_team": true }
```

`to_approve` is what waits for **this person** to approve.

---

## 4. Expenses

### An expense, as the server gives it

```json
{
  "id": 208, "user_id": 12, "user_name": "Ravi Kumar",
  "expense_date": "2026-10-04", "category_id": 4, "category_name": "Food", "kind": "amount",
  "amount": 450.5, "tax_amount": 21.45, "currency": "INR", "paid_by": "self",
  "merchant": "Hotel Sagar", "city": "Pune", "description": "Lunch with client", "bill_number": "B-17", "gstin": "27ABCDE1234F1Z5",
  "km": null, "vehicle": "", "rate": null, "from_place": "", "to_place": "", "days": null,
  "related": { "module": "leads", "id": 3127, "name": "Sharma Traders", "link": "/leads/3127" },
  "lat": null, "lng": null,
  "status": "open", "claim_id": null, "claim_number": null, "claim_status": null,
  "approved_amount": null, "approver_note": "",
  "foreign": false, "orig_amount": 450.5, "orig_tax": 21.45, "fx_rate": 1,
  "flags": [ { "code": "over_expense", "hard": true, "text": "Over the limit for one Food expense (₹400)" } ],
  "receipts": 1, "receipt_list": [ { "id": 77, "file_name": "bill.jpg", "mime": "image/jpeg", "size": 184220, "has_thumb": true, "thumb": "/9j/4AAQ…" } ],
  "client_ref": "5f0c…", "can_edit": true,
  "created_at": "…", "updated_at": "…"
}
```

- `status`: `open` (can be changed) → `submitted` (with the approver) →
  `approved` / `rejected` → `paid`.
- `paid_by`: `self` (the person paid — it is paid back) or `company` (company
  card — recorded, not paid back).
- `flags`: what the company's rules say about it. Show the `text`. Codes:
  `over_expense`, `over_day`, `over_month`, `no_receipt`, `no_note`, `too_old`
  (all `hard`) and `duplicate` (a remark only).
- `can_edit`: only the owner, only while `status` is `open`.
- `foreign: true` — a bill in another currency: `currency` is that currency,
  `orig_amount` / `orig_tax` what the bill says, `fx_rate` the rate used.
  `amount` and `tax_amount` are ALWAYS in the CRM currency.
- `thumb` is a small JPEG as base64 (`data:image/jpeg;base64,<thumb>`). It is
  sent along in an expense, in a list asked with `with_thumbs=1`, and in a
  claim of up to 60 expenses. Where it is not sent along, `has_thumb` says
  whether there is one to fetch with `GET /api/expenses/receipts/:rid?thumb=1`.

### Add one

```
POST /api/expenses
{
  "client_ref": "5f0c2d1e-…",            ← make a new random id for every NEW expense (see "Offline" below)
  "expense_date": "2026-10-04",
  "category_id": 4,
  "amount": 450.50,                      ← kind "amount" (and "per_day" without a daily rate)
  "km": 42, "vehicle": "Two-wheeler", "from_place": "Office", "to_place": "Client",   ← kind "mileage"
  "days": 2,                             ← kind "per_day"
  "paid_by": "self",
  "merchant": "Hotel Sagar", "city": "Pune", "description": "Lunch with client",
  "bill_number": "B-17", "gstin": "27ABCDE1234F1Z5", "tax_amount": 21.45,
  "related_module": "leads", "related_record_id": 3127,
  "lat": 18.52, "lng": 73.85,
  "claim_id": 12,                        ← optional: put it straight into a draft claim of mine
  "receipts": [ { "file_name": "bill.jpg", "mime": "image/jpeg", "data": "<base64>", "thumb": "<small JPEG, base64>" } ]
}

201 → the expense          (200 with "already_saved": true when this client_ref was saved before)
```

Only `expense_date`, `category_id` and the amount (or km + vehicle, or days)
are needed.

**A bill in another currency** (only kind `amount`, only with `multi_currency`):
send `"currency": "USD", "orig_amount": 45.20, "orig_tax": 5` (optional) and,
when the person typed it, `"fx_rate": 84.1` (one USD in the CRM currency). Do
not send `amount`: the server works it out. Without `fx_rate` the CRM rate is
used. A typed rate more than `fx_tolerance` % away is saved with the flag
`fx_rate`; one more than 20 times off is refused.

### Bills (two ways to send them)

1. **Inside the JSON** (`receipts`, as above). `data` is the file as base64
   (a `data:image/jpeg;base64,…` address works too). `thumb` is optional: a
   small JPEG (about 220 px) the lists can show quickly.
2. **As a normal file upload** — often easier in an app:

```
POST /api/expenses            Content-Type: multipart/form-data
  data      = {"client_ref":"…","expense_date":"2026-10-04","category_id":4,"amount":450.5}     (one field holding the JSON)
  receipts  = <file>          (repeat for up to 6 files)
```

   (Plain form fields `expense_date`, `category_id`, `amount`… work as well
   instead of `data`.)

Rules: JPG, PNG, WEBP or PDF; `rules.max_receipt_mb` each; 6 per expense.
**Make a photo smaller before sending** (longest side 1,600 px, JPEG quality
about 70% gives ~200 KB and stays perfectly readable). The same bill sent
twice is kept once.

```
POST   /api/expenses/:id/receipts        add bills later (JSON { "receipts": [...] } or a file upload)
DELETE /api/expenses/receipts/:rid       remove one  → the expense
GET    /api/expenses/receipts/:rid       the bill itself (the picture / the PDF)
GET    /api/expenses/receipts/:rid?thumb=1   its small picture (404 when it has none)
```

Send the `Authorization` header with these too.

### Ask the rules without saving

```
POST /api/expenses/check
{ "category_id": 4, "expense_date": "2026-10-04", "amount": 2000, "description": "x", "receipts_count": 1, "id": 208 (when changing one) }
→ { "amount": 2000, "rate": null, "flags": [ … ] }
```

Use it while the form is filled in, to show the remarks before saving (and the
worked-out amount for km / days).

### List, open, change, delete

```
GET    /api/expenses?status=open&unclaimed=1&from=2026-10-01&to=2026-10-31&category_id=4&q=sagar&page=1&page_size=100&with_thumbs=1
       → { "rows": [ … ], "total": 4, "amount": 2057, "page": 1, "page_size": 100 }
GET    /api/expenses/:id
PUT    /api/expenses/:id        send only what changed (and "receipts" to add bills)
DELETE /api/expenses/:id
```

Filters (all optional): `scope` (`mine` — the default, `team` — the people
below me, `all` — everyone, for the finance team), `user_id`, `status`,
`unclaimed=1`, `claim_id`, `from`, `to`, `category_id`, `related_module` +
`related_record_id`, `flagged=1`, `q`, `updated_since`, `page`, `page_size`
(500 at most; 100 with `with_thumbs=1`).

An expense can be changed or deleted only by its owner, and only while its
`status` is `open`. Otherwise the answer is 409.

### Finding the customer to link

```
GET /api/search/lookup/leads?q=sharma&limit=12        (also: contacts, accounts, opportunities)
→ { "results": [ { "id": 3127, "label": "Sharma Traders", "sub": "9876543210" } ] }
```

---

## 4b. Reading a bill photo

```
POST /api/expenses/bill-reading
{ "text": "HOTEL SAI PALACE\nGSTIN 27AACCT6552B1ZI\n…Grand Total 2,688.00" }     ← bill_reading "device"
{ "image": { "mime": "image/jpeg", "data": "<base64>" } }                      ← bill_reading "ai" (or a file upload "receipts")

200 → { "source": "text" | "ai",
        "fields": { "amount": 2688, "tax_amount": 288, "expense_date": "2026-10-03", "merchant": "Hotel Sai Palace",
                    "bill_number": "SP/2456", "gstin": "27AACCT6552B1ZI", "currency": "USD", "category_id": 6 },
        "sure":   { "amount": "high", "gstin": "high", "category_id": "low", … },
        "found": 7 }
```

- With `device`, the app reads the photo itself (Android: ML Kit text
  recognition; iPhone: Vision) and sends only the text. Free, private.
- Only what was found is in `fields`. Nothing is saved: show the values, let
  the person correct them, then save the expense as usual.
- Too many in a few minutes → 429 (60 texts / 15 photos in 5 minutes).
  `bill_reading: "off"` → 409. A photo while the mode is `device` → 409.

## 5. Claims

Expenses are put together in a **claim** and the claim is sent for approval.

| `status` | Meaning |
|---|---|
| `draft` | Not sent yet |
| `submitted` | With an approver (`approver_name`; `level` 2 = second approval) |
| `approved` | Approved — waiting for the finance team to pay |
| `paid` | Paid (or closed with nothing to pay) |
| `returned` | Sent back for correction — change it and send it again |
| `rejected` | Refused. The end. |

`stage` is the same in words, ready to show (`"With Meera Manager"`).

```
POST /api/expenses/claims
{ "client_ref": "…", "title": "Pune visit", "purpose": "…", "expense_ids": [208, 209] | "all", "submit": true }
201 → the claim (with its "expenses" and "history")
```

- `expense_ids: "all"` takes every expense of mine that is in no claim yet.
- `submit: true` sends it at once. Without it the claim is a draft.
- When the company's rule is "do not allow" and an expense is outside the
  rules, the answer is **400** with the list; the draft is kept:

```json
{ "error": "One expense is outside the rules. Correct it and send the claim again.",
  "claim_id": 12,
  "blocked": [ { "expense_id": 208, "expense_date": "2026-10-04", "category_name": "Food", "amount": 1200,
                 "problems": ["Over the limit for one Food expense (₹400)"] } ] }
```

```
GET    /api/expenses/claims?status=submitted,approved&scope=mine&q=&page=1
GET    /api/expenses/claims/:id
PUT    /api/expenses/claims/:id       { "title", "purpose", "add_expense_ids": [..], "remove_expense_ids": [..] }     (draft / returned only)
DELETE /api/expenses/claims/:id       (only a draft that was never sent; its expenses are kept)
POST   /api/expenses/claims/:id/submit
POST   /api/expenses/claims/:id/withdraw      take it back while it is with the approver
```

A claim answer carries `can`: what **this person** may do with it now —
`edit`, `submit`, `remove`, `withdraw`, `decide` (approve / reject / send
back), `finance` (correct / pay), `reassign`. Show the buttons from `can`.

### For approvers

```
GET /api/expenses/approvals            → { "claims": [ … ], "advances": [ … ] }   what waits for me
      ?scope=team   what waits (with anyone) from the people below me
      ?scope=all    everything that waits (finance team)
```

```
POST /api/expenses/claims/:id/approve
{ "seen": "<the claim's updated_at as it was shown>",
  "note": "Fine",
  "lines": [ { "id": 208, "approved_amount": 300, "note": "Only the food part" },
             { "id": 209, "approved_amount": 0,   "note": "Personal" } ] }
```

- **`seen` is needed — for approve, return, reject and correct.** It is the
  `updated_at` of the claim the person looked at. If the claim changed since
  (taken back, corrected, sent again), the answer is 409 with `"stale": true`
  and nothing happens: load the claim again, show it, and let the person
  decide again. Never retry by itself with the new `updated_at`.
- A line that is not named is approved as it stands. An amount below what was
  claimed needs a `note`. `0` refuses that line. Never more than was claimed.

```
POST /api/expenses/claims/:id/return     { "seen", "note": "Attach the cab bill", "lines": [ { "id": 208, "note": "Bill missing" } ] }
POST /api/expenses/claims/:id/reject     { "seen", "note": "Not a business expense" }
```

`note` is needed for both. "Return" gives the claim back to be corrected;
"reject" is final.

### For the finance team

```
GET  /api/expenses/finance/payable       approved claims and advances waiting for money
POST /api/expenses/claims/:id/correct    { "seen", "note", "lines": [ … ] }      change approved amounts before paying
POST /api/expenses/claims/:id/reassign   { "approver_id": 7, "note": "On leave" }  give a waiting claim to another approver
POST /api/expenses/finance/pay
     { "claim_ids": [12, 14], "paid_on": "2026-10-05", "mode": "Bank transfer", "reference": "NEFT-1001",
       "adjust_advance": true, "expected_total": 1110 }
     → { "payout": { "payout_number": "PAY-00003", "total": 1110, "claims": 2, … }, "paid": [ … ], "skipped": [ { "id": 15, "reason": "Already paid" } ] }
GET  /api/expenses/finance/payouts       the payment runs
GET  /api/expenses/finance/payouts/:id   the claims in one run
```

- `mode` must be one of `payment_modes` (in `meta` for finance people).
  300 claims at most in one call.
- An advance the person still holds is taken off first, oldest claim first.
- `expected_total`: what the screen showed as "to pay" for these claims. If the
  server now works out another figure, nothing is paid (409, `"stale": true`,
  and the new `expected_total`).
- The CRM **records** the payment. It does not move money.

---

## 6. Advances

```
POST /api/expenses/advances            { "client_ref": "…", "amount": 3000, "purpose": "Nagpur trip", "needed_by": "2026-10-12" }
GET  /api/expenses/advances            → { "rows": [ … ], "total": 3, "balance": 1000 }     (balance = what I hold now)
GET  /api/expenses/advances/:id        with "uses" (how it was used) and "history"
POST /api/expenses/advances/:id/cancel
POST /api/expenses/advances/:id/approve   { "amount": 2000, "note": "Two days only" }     (the approver; less than asked needs a note)
POST /api/expenses/advances/:id/reject    { "note": "…" }
POST /api/expenses/advances/:id/pay       { "paid_on", "mode", "reference" }             (finance)
POST /api/expenses/advances/:id/return    { "client_ref": "…", "amount": 400, "note": "Unused" }   (finance: money handed back)
```

`status`: `requested` → `approved` → `paid` (the person holds it; `balance`
is what is left) → `closed`; or `rejected` / `cancelled`.

---

## 7. Reports

```
GET /api/expenses/reports/:name?from=2026-10-01&to=2026-10-31&user_id=&category_id=
```

`name`: `summary`, `by_employee`, `by_category`, `by_customer`, `by_month`,
`exceptions`, `pending`, `mileage`, `advances`, `register`.

Every report has the same shape, so one table can show them all:

```json
{ "name": "by_category", "title": "By category", "from": "2026-10-01", "to": "2026-10-31",
  "columns": [ { "key": "category_name", "label": "Category", "type": "text" }, { "key": "amount", "label": "Amount", "type": "money" }, … ],
  "rows": [ { "category_name": "Food", "count": 3, "amount": 1250, … } ],
  "totals": { "amount": 2307, … } }
```

A person sees their own figures; a manager their team's; the finance team
everyone's. Add `&format=csv` for a file (needs the "export" permission).

---

## 8. Working offline (the important part)

A field person often has no signal. The app should let them enter expenses
anyway and send them later. Three things make this safe:

**1. `client_ref` — nothing is ever saved twice.**
For every NEW expense, claim or advance the app makes a random id (a UUID) and
keeps it with the entry. It sends it as `client_ref`. If the answer is lost
and the app sends the same entry again, the server finds the `client_ref`,
saves nothing new and answers `200` with `"already_saved": true` and the entry
as it was saved the first time. So: **when in doubt, send again.**
(A `client_ref` belongs to one entry. To change an expense that is already
saved, use `PUT /api/expenses/:id`.)

**2. `sync` — get what changed.**

```
GET /api/expenses/sync                      first time: everything of mine (the newest 2,000 expenses)
GET /api/expenses/sync?since=<server_time>  after that: only what changed

→ { "server_time": "2026-10-05T15:02:11.090Z", "full": false, "more": false,
    "expenses": [ … ], "claims": [ … ], "advances": [ … ],
    "deleted": [ { "kind": "expense", "id": 207 }, { "kind": "claim", "id": 11 } ] }
```

Keep `server_time` from the answer and send it as `since` next time. While
`more` is `true`, call again at once with the new `server_time`. Store rows
by their `id` (a row can come twice — keep the one with the later
`updated_at`). Remove what is in `deleted`. This is also how the app learns that a claim was approved, sent
back or paid.

**3. A simple order of work when the signal comes back**

1. Send every expense that is waiting (`POST /api/expenses`, each with its `client_ref`).
2. Send the claims that are waiting (`POST /api/expenses/claims`).
3. Call `sync`.
4. Call `summary` for the home screen.

---

## 9. Bank details (when `meta.bank.on`)

```
GET  /api/expenses/bank/me
200 → { "holder_name": "Ravi Kumar", "account": "XXXX9012", "account_last4": "9012", "ifsc": "HDFC0001234",
        "bank_name": "HDFC Bank", "upi_id": "", "bank_status": "none" | "unverified" | "verified",
        "verified_by_name": "", "verified_at": null, "on": true, "can_edit": true }

PUT  /api/expenses/bank/me
{ "holder_name": "Ravi Kumar", "account_number": "123456789012", "ifsc": "HDFC0001234", "bank_name": "HDFC Bank", "upi_id": "ravi@okhdfc" }
```

- The full account number is never sent back. Leave `account_number` out to
  keep the one that is there.
- Any change makes the details `unverified`; the finance team checks them
  before anything is paid to them.
- `can_edit: false` — the company has the finance team enter them.

The finance team's own links (`/bank/people`, `/bank/batches…`, `/tally/…`)
are used by the web screens only.

## 10. Small print

- A claim holds 300 expenses at most; an expense 6 bills.
- A request can be 30 MB at most. Send large bills one at a time.
- Texts are stored as they are typed. Show them as text, never as HTML.
- The same person cannot approve or pay their own claim (the server refuses).
- Notifications of the CRM (the bell) tell the person when a claim is
  approved, sent back or paid: `GET /api/notifications`.
