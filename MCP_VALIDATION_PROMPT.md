# Receipt Vault: MCP & Ledger End-to-End Evaluation Prompt

> **Instructions for Claude / AI Assistant:**
> You are connected to **Receipt Vault** via the Model Context Protocol (MCP).
> Please execute this test plan sequentially to validate all 9 MCP tools, forensic audit features, policy compliance checks, and ledger operations.
> After each phase, report the tool output and confirm whether it succeeded.

---

## Phase 1: Ledger Inspection & Baseline Summary
1. Call `list_expenses` with `limit: 500` to inspect all current records in the ledger.
2. Call `monthly_summary` without arguments (or with `month: "all"`) to get the high-level spend, tax, and category breakdown.

---

## Phase 2: Ingest Single Receipts with Edge Cases
1. **Receipt with Gratuity / Tip (Verify Tip Contextualization):**
   Call `add_expense` with:
   - `vendor`: `"Joe's Diner"`
   - `date`: `"2026-11-09"`
   - `amount`: `45.00`
   - `tax`: `2.50`
   - `category`: `"Meals"`
   - `payment_method`: `"Corporate Visa"`
   - `notes`: `"Line items sum to $40.00, subtotal with tax is $42.50, total is $45.00 ($2.50 tip)"`
   - `items`: `[{"description": "Burger Combo", "amount": 25.00}, {"description": "Craft Soda", "amount": 15.00}]`
   - `discrepancy`: `"Likely tip/gratuity ($2.50) added to subtotal"`
   - `image_url`: `"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='260' style='background:#fcfaf2;font-family:monospace;padding:15px;'><text x='10' y='30' font-size='14' font-weight='bold'>JOE'S DINER</text><text x='10' y='50' font-size='10'>Date: 2026-11-09</text><line x1='10' y1='65' x2='200' y2='65' stroke='#ccc'/><text x='10' y='90' font-size='11'>Burger Combo: $25.00</text><text x='10' y='110' font-size='11'>Craft Soda: $15.00</text><text x='10' y='135' font-size='11'>Tax: $2.50</text><text x='10' y='165' font-size='12' font-weight='bold'>TOTAL: $45.00</text><text x='10' y='200' font-size='9' fill='#555'>INCLUDES $2.50 GRATUITY</text></svg>"`
   *(Confirm that the vault identifies this as a legitimate meal tip rather than an alarming calculation error).*

2. **International Receipt with UK Date & Currency Symbol:**
   Call `add_expense` with:
   - `vendor`: `"The Cider Cellar"`
   - `date`: `"24/09/2018"`
   - `amount`: `"£4.50"`
   - `currency`: `"£"`
   - `tax`: `"£0.75"`
   - `category`: `"Meals"`
   - `payment_method`: `"Cash"`
   - `notes`: `"2x Bulmers (£8.00 subtotal) less £3.50 promo discount and price override. Paid cash."`
   - `items`: `[{"description": "Bulmers Cider x2", "amount": 8.00}, {"description": "Promotional Discount", "amount": -3.50}]`
   *(Confirm that the parser normalizes the UK date to `2018-09-24` and the currency to `GBP` $4.50).*

3. **Duplicate Detection Test:**
   Attempt to call `add_expense` again with the exact same values for `Joe's Diner` (`vendor`: `"Joe's Diner"`, `date`: `"2026-11-09"`, `amount`: `45.00`) without setting `allow_duplicate`. Verify that the vault guards against duplicate creation.

---

## Phase 3: Batch Ingestion & Procurement Structuring Test
Call `batch_add_expenses` with multiple purchases on the same day designed to test single-vendor micro-procurement structuring detection:
```json
{
  "expenses": [
    {
      "vendor": "Acme Electronics",
      "date": "2026-11-10",
      "amount": 65.00,
      "category": "Office Supplies",
      "tax": 5.20,
      "notes": "Monitor arm bracket (part 1 of workstation upgrade)"
    },
    {
      "vendor": "Acme Electronics",
      "date": "2026-11-10",
      "amount": 70.00,
      "category": "Office Supplies",
      "tax": 5.60,
      "notes": "Ergonomic keyboard (part 2 of workstation upgrade)"
    },
    {
      "vendor": "Figma Inc",
      "date": "2026-11-01",
      "amount": 15.00,
      "category": "Software",
      "tax": 1.50,
      "notes": "Product Design Seat"
    }
  ]
}
```

---

## Phase 4: Policy Compliance Pre-Checks
1. Check policy on an expensive dinner with alcohol:
   Call `check_policy` with:
   - `vendor`: `"The Capital Grille"`
   - `amount`: `185.00`
   - `category`: `"Meals"`
   - `date`: `"2026-11-08"`
   - `notes`: `"Client closing dinner with bottle of red wine"`
   - `tax`: `0`
   *(Verify it flags: meal exceeds standard $75 corporate limit, weekend transaction, alcohol detected, and missing tax).*

2. Check policy on a compliant standard expense:
   Call `check_policy` with:
   - `vendor`: `"Fastly CDN"`
   - `amount`: `45.00`
   - `category`: `"Software"`
   - `date`: `"2026-11-05"`
   - `tax`: `4.50`
   *(Verify it returns policy compliant).*

---

## Phase 5: Forensic Audit & Anomaly Detection
1. Call `audit_anomalies` to run the fraud and policy check across the ledger. Verify it accurately flags:
   - **Split Structuring:** The Acme Electronics split receipts on `2026-11-10` that total $135 (bypassing the $75 micro-procurement approval limit).
   - **Weekend Spend:** Any weekend transactions requiring business justification.
   - **Gratuity Verification:** Joe's Diner verified as a low-risk gratuity/tip.
2. Call `spending_insights` to get top spenders, category distributions, and deductible VAT/tax totals.

---

## Phase 6: Suggested Tax Treatment & Accountant Review Schedule
Call `tax_deduction_report` with `month: "2026-11"` (or all time) to generate the suggested tax schedule:
- 100% deductible standard business expenses (Software, Office Supplies, Travel)
- 50% partial write-off estimate for Meals & Client Entertainment
- Itemized VAT/GST recoverable input tax credits for CPA review.

---

## Phase 7: Expense Modification & Verification
1. Call `list_expenses` with `search: "Cider Cellar"` to obtain its assigned ID.
2. Call `update_expense` using that ID, adding notes: `"Confirmed with UK team: authorized client beverage."`
3. Confirm that the expense now reflects the updated note and review status.
