# Receipt Vault

A permanent, editable expense ledger that Claude fills in over MCP.
The app has **no AI inside**: no AI keys, no AI SDKs, zero dependencies. Claude (on the customer's own plan) reads the receipt photo; this app stores, edits, summarises and exports.

## Run locally
    node server.js          # http://localhost:3000   (Node 18+)
    node test.js            # end-to-end tests

## Deploy (about 10 minutes)
**Render (recommended):** push this folder to GitHub, then New > Blueprint, pick the repo. `render.yaml` sets up the service and a persistent disk. Add `DEMO_PASSWORD` in the dashboard.
The disk matters: without it the ledger resets on each deploy. Fly.io, Railway and any VPS also work: run `node server.js` and mount a volume at `DATA_DIR`.

Env vars: `PORT` (auto), `DATA_DIR` (where vault.json lives), `BASE_URL` (optional, forces the public URL shown in the connector link), `DEMO_EMAIL` + `DEMO_PASSWORD` (seeds a test login).

## Connect to Claude
1. Open the live app and sign in (or create an account).
2. Copy your private connector link from the "Connect Claude" panel. It looks like `https://YOUR-APP/mcp/<secret>`.
3. Claude > Settings > Connectors > Add custom connector. Name: Receipt Vault. URL: the link. Save.
4. New chat, attach a receipt photo: "Add this to my Receipt Vault."

Tools: `add_expense`, `list_expenses`, `update_expense`, `monthly_summary`, `spending_insights`, `check_policy`.

- **Floating Bill Notice Board:** Tactile corkboard view where bills & receipt photos are visually pinned with realistic pushpins, stacked by month, with discrepancy caution tape and an image zoom lightbox.
- **Audit & Math Discrepancy Engine:** Auto-flags when itemized lines don't add up to the receipt total (e.g., pie charges, tax calculation mismatches) with warning badges.
- **Corporate Policy Compliance:** Checks expenses against spend policies (e.g. meal limits > $75, weekend transactions, itemized alcohol, missing VAT/tax).
- **Executive Analytics (`spending_insights`):** Claude acts as your financial analyst, answering queries about top spenders, quarterly variance, and policy compliance.
- **Pre-submission Policy Checker (`check_policy`):** Pre-validates purchases against corporate rules directly in Claude chat.
- **1-Click Accounting Exports:**
  - **Volopay Reconciliation CSV:** Formatted directly for Volopay corporate card / ledger reconciliation.
  - **QuickBooks & Xero Formats:** Ready for accountant journal and bills import.
  - **Standard CSV:** Complete audit ledger with formula-injection security.
- **Fintech KPI Dashboard:** Real-time metrics for Total Spend, Pending Review count, Policy / Math Flags, and Tax Deductibles Tracked.

## Design notes
- Free & Open for Stage 1: Zero subscription fees, paywalls, or third-party paid dependencies.
- Auth for the MCP link is a per-user secret URL (simple, secure, and zero-friction for v1).
- Claude-created rows are flagged "needs review" until a person confirms or edits them.
- `add_expense` rejects likely duplicates so a re-sent photo does not double-count.
- CSV export neutralises spreadsheet formula injection.
- Storage is a single JSON file with atomic writes. Swap to Postgres when you pass a few hundred users.
