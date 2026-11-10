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

Tools: `add_expense`, `list_expenses`, `update_expense`, `monthly_summary`.

## Design notes
- Free & Open for Stage 1: Zero subscription fees, paywalls, or third-party paid dependencies.
- Auth for the MCP link is a per-user secret URL (simple, secure, and zero-friction for v1).
- Claude-created rows are flagged "needs review" until a person confirms or edits them.
- `add_expense` rejects likely duplicates so a re-sent photo does not double-count.
- CSV export neutralises spreadsheet formula injection.
- Storage is a single JSON file with atomic writes. Swap to Postgres when you pass a few hundred users.
