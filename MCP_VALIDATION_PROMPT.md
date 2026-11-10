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
1. **Receipt with Line Discrepancy & Tip:**
   Call `add_expense` with:
   - `vendor`: `"Joe's Diner"`
   - `date`: `"2026-11-09"`
   - `amount`: `45.00`
   - `tax`: `2.50`
   - `category`: `"Meals"`
   - `payment_method`: `"Corporate Visa"`
   - `notes`: `"Line items sum to $40.00, subtotal with tax is $42.50, printed total is $45.00 ($2.50 tip)"`
   - `items`: `[{"description": "Burger Combo", "amount": 25.00}, {"description": "Craft Soda", "amount": 15.00}]`
   - `discrepancy`: `"Line items plus tax equal $42.50, but total is $45.00"`
   - `image_url`: `"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='280' style='background:#fcfaf2;font-family:monospace;padding:15px;box-sizing:border-box;'><text x='10' y='30' font-size='14' font-weight='bold'>JOE'S DINER</text><text x='10' y='50' font-size='10'>Date: 2026-11-09</text><line x1='10' y1='65' x2='200' y2='65' stroke='#ccc'/><text x='10' y='90' font-size='11'>Burger Combo: $25.00</text><text x='10' y='110' font-size='11'>Craft Soda: $15.00</text><text x='10' y='140' font-size='11'>Tax: $2.50</text><text x='10' y='170' font-size='12' font-weight='bold'>TOTAL PAID: $45.00</text><text x='10' y='210' font-size='9' fill='#c00'>DISCREPANCY: $2.50 TIP</text></svg>"`

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

3. **Duplicate Detection Test:**
   Attempt to call `add_expense` again with the exact same values for `Joe's Diner` (`vendor`: `"Joe's Diner"`, `date`: `"2026-11-09"`, `amount`: `45.00`) without setting `allow_duplicate`. Verify that the vault guards against duplicate creation.

---

## Phase 3: Batch Ingestion & Split Structuring
Call `batch_add_expenses` with multiple purchases on the same day designed to test structuring detection:
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

## Phase 4: Policy Compliance & Pre-Checks
1. Check policy on an expensive dinner with alcohol:
   Call `check_policy` with:
   - `vendor`: `"The Capital Grille"`
   - `amount`: `185.00`
   - `category`: `"Meals"`
   - `date`: `"2026-11-08"`
   - `notes`: `"Client closing dinner with bottle of red wine"`
   - `tax`: `0`
   *(Verify it flags meal > $75 cap, weekend date, alcohol note, and missing tax).*

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
1. Call `audit_anomalies` to run the full audit algorithm. Verify it detects:
   - **Split Structuring:** The Acme Electronics split receipts on `2026-11-10` that total $135 (bypassing the $75 cap).
   - **Weekend Spend:** Any weekend transactions.
   - **Math Discrepancies:** The Joe's Diner tip/discrepancy flag.
2. Call `spending_insights` to get top spenders, category distributions, and deductible VAT/tax totals.

---

## Phase 6: Tax Deduction & Accountant Schedule
Call `tax_deduction_report` with `month: "2026-11"` (or all time) to generate the tax write-off breakdown:
- 100% deductible business expenses (Software, Office Supplies, Travel)
- 50% partial write-offs (Meals & Entertainment)
- Itemized VAT/GST recoverable input tax credits.

---

## Phase 7: Expense Modification & Human Verification
1. Call `list_expenses` with `search: "Cider Cellar"` to obtain its newly assigned ID.
2. Call `update_expense` using that ID, adding notes: `"Confirmed with UK team: authorized client beverage."`
3. Confirm that the expense now reflects the updated note and review status.
