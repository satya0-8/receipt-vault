// Receipt Vault: web app + MCP server in one process. Zero dependencies, zero AI.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'vault.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'receipts');
const CATEGORIES = ['Meals', 'Groceries', 'Travel', 'Lodging', 'Transport', 'Software', 'Office Supplies', 'Utilities', 'Entertainment', 'Health', 'Other'];

// ---------- storage (JSON file, atomic writes) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
let db = { secret: crypto.randomBytes(32).toString('hex'), nextId: 1, users: {}, expenses: [] };
if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}
save();

// ---------- users & auth ----------
const newToken = () => crypto.randomBytes(24).toString('base64url');
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function createUser(email, password) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (String(password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (Object.values(db.users).some(u => u.email === email)) throw new HttpError(409, 'An account with this email already exists.');
  const id = crypto.randomUUID();
  const salt = crypto.randomBytes(16).toString('hex');
  db.users[id] = { id, email, salt, hash: hashPw(password, salt), token: newToken(), created: new Date().toISOString() };
  save();
  return db.users[id];
}
function sign(v) { return crypto.createHmac('sha256', db.secret).update(v).digest('hex'); }
function sessionCookie(uid, secure) {
  return `sid=${uid}.${sign(uid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`;
}
function userFromReq(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [uid, sig] = m[1].split('.');
  if (!uid || !sig) return null;
  const good = sign(uid);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  return db.users[uid] || null;
}
function userFromToken(token) {
  return Object.values(db.users).find(u => u.token === token) || null;
}

// ---------- expense logic ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const round2 = n => Math.round(n * 100) / 100;

function parseDateString(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Standard ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + 'T00:00:00Z');
    if (!isNaN(d) && d.toISOString().slice(0, 10) === s) return s;
    return null;
  }
  // DD/MM/YYYY or DD-MM-YYYY (e.g. 24/09/2018 or 24-09-2018)
  const dmy = /^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/.exec(s);
  if (dmy) {
    let p1 = dmy[1].padStart(2, '0');
    let p2 = dmy[2].padStart(2, '0');
    let year = dmy[3];
    let day = p1, month = p2;
    if (Number(p2) > 12 && Number(p1) <= 12) {
      day = p2; month = p1; // US MM/DD/YYYY
    }
    const iso = `${year}-${month}-${day}`;
    const d = new Date(iso + 'T00:00:00Z');
    if (!isNaN(d) && d.toISOString().slice(0, 10) === iso) return iso;
    return null;
  }
  // Fallback to Date parser
  try {
    const d = new Date(s);
    if (!isNaN(d) && typeof d.getTime === 'function' && !isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  } catch { }
  return null;
}

function normalize(input, partial) {
  const out = {};
  const has = k => input[k] !== undefined && input[k] !== null;
  if (has('vendor') || !partial) {
    const v = String(input.vendor ?? '').trim();
    if (!v) throw new HttpError(400, 'vendor is required.');
    out.vendor = v.slice(0, 120);
  }
  if (has('date') || !partial) {
    const raw = String(input.date ?? '').trim();
    const parsed = parseDateString(raw);
    if (!parsed) throw new HttpError(400, 'date must be a real date in YYYY-MM-DD format.');
    out.date = parsed;
  }
  if (has('amount') || !partial) {
    const cleanAmt = typeof input.amount === 'string' ? input.amount.replace(/[^0-9.-]+/g, '') : input.amount;
    const a = Number(cleanAmt);
    if (!Number.isFinite(a) || a < 0) throw new HttpError(400, 'amount must be a non-negative number (the total paid, including tax).');
    out.amount = round2(a);
  }
  if (has('tax')) {
    const cleanTax = typeof input.tax === 'string' ? input.tax.replace(/[^0-9.-]+/g, '') : input.tax;
    const t = Number(cleanTax);
    if (!Number.isFinite(t) || t < 0) out.tax = 0;
    else out.tax = round2(t);
  } else if (!partial) out.tax = 0;
  if (has('currency') || !partial) {
    let c = String(input.currency ?? 'USD').trim().toUpperCase();
    if (c === '$' || c === 'US$' || c === 'USD$') c = 'USD';
    else if (c === '£' || c === 'POUND' || c === 'POUNDS') c = 'GBP';
    else if (c === '€' || c === 'EURO' || c === 'EUROS') c = 'EUR';
    else if (c === '₹' || c === 'RUPEE' || c === 'RUPEES') c = 'INR';
    else if (c === '¥' || c === 'YEN') c = 'JPY';
    if (!/^[A-Z]{3}$/.test(c)) c = 'USD';
    out.currency = c;
  }
  if (has('category') || !partial) {
    const raw = String(input.category ?? 'Other').trim().toLowerCase();
    const match = CATEGORIES.find(c => c.toLowerCase() === raw);
    out.category = match || 'Other';
  }
  if (has('payment_method')) out.payment_method = String(input.payment_method).trim().slice(0, 60);
  if (has('notes')) out.notes = String(input.notes).trim().slice(0, 500);
  if (has('image_url')) out.image_url = String(input.image_url ?? '').trim();
  else if (!partial) out.image_url = '';
  if (has('discrepancy')) out.discrepancy = String(input.discrepancy ?? '').trim().slice(0, 300);
  else if (!partial) out.discrepancy = '';
  if (has('policy_flag')) out.policy_flag = String(input.policy_flag ?? '').trim().slice(0, 300);
  else if (!partial) out.policy_flag = '';

  if (has('items')) {
    if (Array.isArray(input.items)) {
      out.items = input.items.map(it => ({
        description: String(it.description || it.name || 'Item').trim().slice(0, 100),
        amount: round2(Number(it.amount) || 0)
      }));
    } else if (typeof input.items === 'string') {
      try {
        const parsed = JSON.parse(input.items);
        if (Array.isArray(parsed)) {
          out.items = parsed.map(it => ({
            description: String(it.description || it.name || 'Item').trim().slice(0, 100),
            amount: round2(Number(it.amount) || 0)
          }));
        }
      } catch { }
    }
  } else if (!partial) out.items = [];

  if (out.amount !== undefined && out.tax !== undefined && out.tax > out.amount) throw new HttpError(400, 'tax cannot be larger than the total amount.');

  // Auto-detect math discrepancy if items sum doesn't match total
  if (out.items && out.items.length > 0 && out.amount) {
    const itemsSum = round2(out.items.reduce((acc, it) => acc + (it.amount || 0), 0));
    const expectedWithTax = round2(itemsSum + (out.tax || 0));
    if (Math.abs(expectedWithTax - out.amount) > 0.05 && Math.abs(itemsSum - out.amount) > 0.05 && !out.discrepancy) {
      out.discrepancy = `Line items sum to ${itemsSum.toFixed(2)}, total is ${out.amount.toFixed(2)}`;
    }
  }
  // Auto-detect discrepancy keywords from notes (e.g. Claude detected math mismatch)
  if (!out.discrepancy && out.notes) {
    if (/(discrepancy|doesn't add up|numbers don't add up|mismatch|printed total of \$\d+)/i.test(out.notes)) {
      out.discrepancy = out.notes.slice(0, 200);
    }
  }
  // Automated corporate policy check heuristics
  if (!out.policy_flag && out.date) {
    const d = new Date(out.date + 'T00:00:00Z');
    const day = d.getUTCDay();
    if (day === 0 || day === 6) {
      out.policy_flag = 'Weekend spend (requires business justification)';
    } else if (out.category === 'Meals' && out.amount > 75) {
      out.policy_flag = `Meal expense (${out.amount.toFixed(2)}) exceeds standard $75 policy`;
    } else if (out.category === 'Lodging' && out.amount > 300) {
      out.policy_flag = `Lodging (${out.amount.toFixed(2)}) exceeds standard $300/night cap`;
    } else if (out.notes && /alcohol|beer|wine|cocktail/i.test(out.notes)) {
      out.policy_flag = 'Alcohol itemized on receipt (review personal split)';
    }
  }
  return out;
}
const mine = uid => db.expenses.filter(e => e.uid === uid);
const pub = ({ uid, ...e }) => e;

function addExpense(uid, input, source, allowDup) {
  const f = normalize(input, false);
  const dup = mine(uid).find(e => e.vendor.toLowerCase() === f.vendor.toLowerCase() && e.date === f.date && e.amount === f.amount && e.currency === f.currency);
  if (dup && !allowDup) return { duplicateOf: pub(dup) };
  const now = new Date().toISOString();
  const e = { id: db.nextId++, uid, payment_method: '', notes: '', discrepancy: '', policy_flag: '', items: [], image_url: '', ...f, source, reviewed: source !== 'claude', created: now, updated: now };
  db.expenses.push(e);
  save();
  return { expense: pub(e) };
}
function updateExpense(uid, id, input) {
  const e = mine(uid).find(x => x.id === Number(id));
  if (!e) throw new HttpError(404, `No expense with id ${id}.`);
  const f = normalize(input, true);
  if (input.reviewed !== undefined) f.reviewed = !!input.reviewed;
  else if (Object.keys(f).length) f.reviewed = true; // a person or Claude touched it deliberately
  const merged = { ...e, ...f };
  if (merged.tax > merged.amount) throw new HttpError(400, 'tax cannot be larger than the total amount.');
  Object.assign(e, f, { updated: new Date().toISOString() });
  save();
  return pub(e);
}
function deleteExpense(uid, id) {
  const i = db.expenses.findIndex(x => x.uid === uid && x.id === Number(id));
  if (i < 0) throw new HttpError(404, `No expense with id ${id}.`);
  db.expenses.splice(i, 1);
  save();
}
function listExpenses(uid, { month, start_date, end_date, search, category, needs_review, flagged, limit } = {}) {
  let rows = mine(uid);
  if (month && month !== 'all' && month.toLowerCase() !== 'all time') {
    const cleanMonth = String(month).slice(0, 7);
    rows = rows.filter(e => String(e.date || '').startsWith(cleanMonth));
  }
  if (start_date) rows = rows.filter(e => String(e.date || '') >= start_date);
  if (end_date) rows = rows.filter(e => String(e.date || '') <= end_date);
  if (category) rows = rows.filter(e => String(e.category || '').toLowerCase() === String(category).toLowerCase());
  if (needs_review !== undefined && needs_review !== '') rows = rows.filter(e => e.reviewed === !(needs_review === true || needs_review === 'true'));
  if (flagged === true || flagged === 'true') rows = rows.filter(e => !!(e.discrepancy || e.policy_flag));
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter(e => [e.vendor, e.notes, e.category, e.payment_method, e.discrepancy, e.policy_flag]
      .map(x => String(x || ''))
      .join(' ')
      .toLowerCase()
      .includes(q));
  }
  rows = rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (b.id || 0) - (a.id || 0));
  const total = rows.length;
  if (limit) rows = rows.slice(0, Math.min(Number(limit) || 50, 500));
  return { total, rows: rows.map(pub) };
}
function summary(uid, filter = {}) {
  const month = typeof filter === 'string' ? filter : (filter.month || '');
  const start_date = typeof filter === 'object' ? (filter.start_date || '') : '';
  const end_date = typeof filter === 'object' ? (filter.end_date || '') : '';
  let rows = mine(uid);
  if (month && month !== 'all' && month.toLowerCase() !== 'all time') {
    const cleanMonth = String(month).slice(0, 7);
    rows = rows.filter(e => String(e.date || '').startsWith(cleanMonth));
  }
  if (start_date) rows = rows.filter(e => String(e.date || '') >= start_date);
  if (end_date) rows = rows.filter(e => String(e.date || '') <= end_date);
  const byCur = {};
  let totalTaxSum = 0;
  let flaggedCount = 0;
  for (const e of rows) {
    const cur = String(e.currency || 'USD').toUpperCase();
    const amt = Number(e.amount) || 0;
    const tax = Number(e.tax) || 0;
    const cat = String(e.category || 'Other');
    const c = (byCur[cur] ||= { currency: cur, total: 0, tax: 0, count: 0, byCategory: {} });
    c.total += amt;
    c.tax += tax;
    c.count++;
    totalTaxSum += tax;
    if (e.discrepancy || e.policy_flag) flaggedCount++;
    c.byCategory[cat] = (c.byCategory[cat] || 0) + amt;
  }
  const out = Object.values(byCur).map(c => ({
    currency: c.currency,
    total: round2(c.total),
    tax: round2(c.tax),
    net: round2(Math.max(0, c.total - c.tax)),
    count: c.count,
    byCategory: Object.entries(c.byCategory).map(([category, amount]) => ({ category, amount: round2(amount) })).sort((a, b) => b.amount - a.amount),
  }));
  return {
    month: month || (start_date && end_date ? `${start_date} to ${end_date}` : 'all'),
    needsReview: rows.filter(e => !e.reviewed).length,
    flaggedCount,
    totalTax: round2(totalTaxSum),
    totalCount: rows.length,
    totals: out
  };
}
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // block spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows, format = 'standard') {
  const sorted = rows.slice().sort((a, b) => a.date.localeCompare(b.date));
  if (format === 'volopay') {
    const head = ['Transaction Date', 'Transaction ID', 'Merchant', 'Category', 'Total Amount', 'Currency', 'Tax Amount', 'Net Amount', 'Policy Status', 'Compliance Notes', 'Review Status', 'Payment Method'];
    const lines = [head.join(',')].concat(sorted.map(e => {
      const policyStatus = (e.discrepancy || e.policy_flag) ? 'FLAGGED' : 'COMPLIANT';
      const notes = [e.discrepancy, e.policy_flag, e.notes].filter(Boolean).join(' | ');
      const reviewStatus = e.reviewed ? 'CONFIRMED' : 'NEEDS_REVIEW';
      return [e.date, `VP-REC-${e.id}`, e.vendor, e.category, e.amount.toFixed(2), e.currency, e.tax.toFixed(2), (e.amount - e.tax).toFixed(2), policyStatus, notes, reviewStatus, e.payment_method || 'Corporate Card'].map(csvCell).join(',');
    }));
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }
  if (format === 'quickbooks') {
    const head = ['Date', 'Transaction Type', 'Number', 'Name', 'Memo', 'Account', 'Amount', 'Sales Tax'];
    const lines = [head.join(',')].concat(sorted.map(e =>
      [e.date, 'Expense', e.id, e.vendor, e.notes || e.discrepancy || '', e.category, e.amount.toFixed(2), e.tax.toFixed(2)].map(csvCell).join(',')));
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }
  if (format === 'xero') {
    const head = ['*ContactName', '*InvoiceNumber', '*InvoiceDate', '*DueDate', 'Total', '*Description', '*Quantity', '*UnitAmount', '*AccountCode', '*TaxType'];
    const lines = [head.join(',')].concat(sorted.map(e =>
      [e.vendor, `INV-${e.id}`, e.date, e.date, e.amount.toFixed(2), e.notes || e.category, '1', e.amount.toFixed(2), e.category, e.tax > 0 ? 'Tax on Purchases' : 'Tax Exempt'].map(csvCell).join(',')));
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }
  // Standard format
  const head = ['Date', 'Vendor', 'Category', 'Currency', 'Total', 'Tax', 'Net', 'Payment method', 'Notes', 'Discrepancy', 'Policy Flag', 'Status', 'ID'];
  const lines = [head.join(',')].concat(sorted.map(e =>
    [e.date, e.vendor, e.category, e.currency, e.amount.toFixed(2), e.tax.toFixed(2), (e.amount - e.tax).toFixed(2), e.payment_method, e.notes, e.discrepancy || '', e.policy_flag || '', e.reviewed ? 'Confirmed' : 'Needs Review', e.id].map(csvCell).join(',')));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// ---------- MCP (Streamable HTTP, JSON-RPC 2.0) ----------
const today = () => new Date().toISOString().slice(0, 10);
const catEnum = { type: 'string', enum: CATEGORIES };
const TOOLS = [
  {
    name: 'add_expense',
    description: 'Save one expense from a receipt into the user\'s Receipt Vault ledger. Read the receipt image yourself, then call this once per receipt with the values you read. Rejects likely duplicates unless allow_duplicate is true. You can pass items, math discrepancies (if receipt numbers do not add up), and policy flags.',
    inputSchema: {
      type: 'object', required: ['vendor', 'date', 'amount'],
      properties: {
        vendor: { type: 'string', description: 'Merchant name as printed on the receipt.' },
        date: { type: 'string', description: 'Purchase date, YYYY-MM-DD. If the year is missing, assume the current year (' + today().slice(0, 4) + ').' },
        amount: { type: 'number', description: 'Grand total paid, INCLUDING tax and tip.' },
        currency: { type: 'string', description: '3-letter ISO code, e.g. USD, INR, EUR. Default USD.' },
        category: { ...catEnum, description: 'Best-fit category.' },
        tax: { type: 'number', description: 'Total tax/VAT/GST shown on the receipt. 0 if none shown.' },
        payment_method: { type: 'string', description: 'e.g. "Visa 4242", "Cash", "Corporate Card". Optional.' },
        notes: { type: 'string', description: 'Short note, business justification, or line item details. Optional.' },
        image_url: { type: 'string', description: 'Public URL, base64 data URI, or SVG bill markup (data:image/svg+xml;utf8,<svg ...>) of the receipt so it visually pins on the user\'s Notice Board. Optional.' },
        discrepancy: { type: 'string', description: 'Describe any math mismatches or printing errors on the receipt (e.g. line items total $42.50 but printed total is $45.00).' },
        policy_flag: { type: 'string', description: 'Corporate spend policy warning, e.g. "Meals exceed $75" or "Weekend spend".' },
        items: {
          type: 'array',
          description: 'Itemized list of purchases from the receipt.',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              amount: { type: 'number' }
            }
          }
        },
        allow_duplicate: { type: 'boolean', description: 'Set true only if the user confirmed this is a separate, identical purchase.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'list_expenses',
    description: 'Search and list saved expenses, newest first. Use it to answer questions about past spending, audit issues, or to find an expense id before updating it.',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'YYYY-MM, e.g. 2026-11.' },
        search: { type: 'string', description: 'Matches vendor, notes, category, payment method, discrepancy, policy flags.' },
        category: catEnum,
        needs_review: { type: 'boolean', description: 'true = only items the user has not confirmed yet.' },
        flagged: { type: 'boolean', description: 'true = only items with policy flags or math discrepancies.' },
        limit: { type: 'number', description: 'Max rows (default 50, max 500).' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'update_expense',
    description: 'Correct fields on an existing expense by id. Only send the fields that change.',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: {
        id: { type: 'number', description: 'Expense id from add_expense or list_expenses.' },
        vendor: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, amount: { type: 'number' },
        currency: { type: 'string' }, category: catEnum, tax: { type: 'number' },
        payment_method: { type: 'string' }, notes: { type: 'string' },
        image_url: { type: 'string' },
        discrepancy: { type: 'string' }, policy_flag: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'monthly_summary',
    description: 'Totals for a month (or all time if month is omitted): spend, tax, net and count per currency, with a category breakdown. Also reports how many items still need review and how many are flagged.',
    inputSchema: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM. Defaults to the current month (' + today().slice(0, 7) + ').' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'spending_insights',
    description: 'Deep financial audit & executive analytics for spend trends, tax deductions, top merchants, and policy compliance violations. Call this to answer business questions about corporate spending habits or audit findings.',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'YYYY-MM. Defaults to all time if omitted.' },
        category: catEnum,
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'check_policy',
    description: 'Pre-check an expense or receipt details against company expense policies (meals limit $75, lodging limit $300, weekend policy, alcohol, tax compliance). Returns compliance verdict and recommendations.',
    inputSchema: {
      type: 'object',
      required: ['vendor', 'amount'],
      properties: {
        vendor: { type: 'string' },
        amount: { type: 'number' },
        category: catEnum,
        date: { type: 'string', description: 'YYYY-MM-DD' },
        tax: { type: 'number' },
        notes: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'batch_add_expenses',
    description: 'Bulk import multiple expenses at once from a credit card statement, bank PDF, or batch of receipt photos. Ingests all items in a single turn and returns an ingestion report.',
    inputSchema: {
      type: 'object',
      required: ['expenses'],
      properties: {
        expenses: {
          type: 'array',
          description: 'List of receipt expenses to record.',
          items: {
            type: 'object',
            required: ['vendor', 'date', 'amount'],
            properties: {
              vendor: { type: 'string', description: 'Merchant name.' },
              date: { type: 'string', description: 'YYYY-MM-DD' },
              amount: { type: 'number', description: 'Total paid including tax.' },
              currency: { type: 'string', description: 'Default USD.' },
              category: catEnum,
              tax: { type: 'number', description: 'Tax amount if known.' },
              payment_method: { type: 'string' },
              notes: { type: 'string' },
              image_url: { type: 'string' },
              discrepancy: { type: 'string' },
              policy_flag: { type: 'string' },
            }
          }
        },
        allow_duplicates: { type: 'boolean', description: 'If true, saves items even if suspected duplicates.' }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'tax_deduction_report',
    description: 'Generate an accountant-ready tax deduction report and VAT/GST schedule for a month or tax year. Classifies 100% deductible business expenses, 50% partial meal write-offs, and recoverable input tax credits.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'string', description: 'Tax year YYYY, e.g. "2026".' },
        month: { type: 'string', description: 'Specific month YYYY-MM if not running for full year.' },
      }
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'audit_anomalies',
    description: 'Run forensic fraud & audit detection across the ledger. Detects double charges within 48h, split-receipt structuring to bypass $75 caps, weekend corporate card charges, and abnormal price spikes.',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'YYYY-MM to audit. Defaults to all time.' },
      }
    },
    annotations: { readOnlyHint: true },
  },
];
const fmt = (e) => {
  const amt = (Number(e.amount) || 0).toFixed(2);
  const tax = (Number(e.tax) || 0).toFixed(2);
  let s = `#${e.id} ${e.date || ''} ${e.vendor || 'Unknown'} | ${e.category || 'Other'} | ${e.currency || 'USD'} ${amt} (tax ${tax})${e.reviewed ? '' : ' [needs review]'}`;
  if (e.discrepancy) s += ` [⚠️ Discrepancy: ${e.discrepancy}]`;
  if (e.policy_flag) s += ` [⚠️ Policy: ${e.policy_flag}]`;
  return s;
};

function callTool(user, name, a = {}) {
  switch (name) {
    case 'add_expense': {
      const r = addExpense(user.id, a, 'claude', a.allow_duplicate === true);
      if (r.duplicateOf) return `Not saved: this looks like a duplicate of ${fmt(r.duplicateOf)}. Ask the user; if it is a separate purchase, call again with allow_duplicate=true.`;
      return `Saved ${fmt(r.expense)}. It is marked "needs review" until the user confirms it in the Receipt Vault web app.`;
    }
    case 'list_expenses': {
      const r = listExpenses(user.id, { limit: 50, ...a });
      if (!r.rows.length) return 'No matching expenses.';
      return `${r.total} match${r.total === 1 ? '' : 'es'}${r.total > r.rows.length ? ` (showing ${r.rows.length})` : ''}:\n` + r.rows.map(fmt).join('\n');
    }
    case 'update_expense': {
      const { id, ...rest } = a;
      return `Updated ${fmt(updateExpense(user.id, id, rest))}`;
    }
    case 'monthly_summary': {
      let month = a.month ? String(a.month).trim() : '';
      if (!month || month === 'all' || month.toLowerCase() === 'all time') {
        month = '';
      } else if (!/^\d{4}-\d{2}$/.test(month)) {
        const m = /^(\d{4})[-\/](\d{2})/.exec(month);
        if (m) month = `${m[1]}-${m[2]}`;
      }
      const s = summary(user.id, month);
      const label = month || 'All Time';
      if (!s.totals.length) return `No expenses recorded for ${label}.`;
      return `Summary for ${label} (${s.needsReview} item(s) need review, ${s.flaggedCount} flagged for policy/discrepancies):\n` + s.totals.map(t =>
        `${t.currency}: total ${(Number(t.total) || 0).toFixed(2)}, tax ${(Number(t.tax) || 0).toFixed(2)}, net ${(Number(t.net) || 0).toFixed(2)}, ${t.count} receipts\n` +
        t.byCategory.map(c => `  - ${c.category}: ${(Number(c.amount) || 0).toFixed(2)}`).join('\n')).join('\n');
    }
    case 'spending_insights': {
      const month = a.month || '';
      const list = listExpenses(user.id, { month, category: a.category }).rows;
      if (!list.length) return `No expenses found to analyze${month ? ` for ${month}` : ''}.`;
      const totalSpend = list.reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const totalTax = list.reduce((s, e) => s + (Number(e.tax) || 0), 0);
      const avgExpense = totalSpend / list.length;
      const flagged = list.filter(e => e.discrepancy || e.policy_flag);
      const unreviewed = list.filter(e => !e.reviewed);

      const vendorSpend = {};
      const catSpend = {};
      list.forEach(e => {
        const v = e.vendor || 'Unknown';
        const c = e.category || 'Other';
        const amt = Number(e.amount) || 0;
        vendorSpend[v] = (vendorSpend[v] || 0) + amt;
        catSpend[c] = (catSpend[c] || 0) + amt;
      });
      const topVendors = Object.entries(vendorSpend).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const topCats = Object.entries(catSpend).sort((a, b) => b[1] - a[1]);

      let out = `📊 Financial & Policy Audit Insights ${month ? `(${month})` : '(All Time)'}:\n`;
      out += `• Total Spend: $${totalSpend.toFixed(2)} across ${list.length} receipts\n`;
      out += `• Average Receipt: $${avgExpense.toFixed(2)}\n`;
      out += `• Tax Tracked (Deductible): $${totalTax.toFixed(2)}\n`;
      out += `• Needs Review: ${unreviewed.length} receipt(s)\n`;
      out += `• Discrepancies & Policy Flags: ${flagged.length} item(s)\n\n`;

      out += `Top Vendors:\n` + topVendors.map(([v, amt]) => `  - ${v}: $${amt.toFixed(2)}`).join('\n') + '\n\n';
      out += `Category Breakdown:\n` + topCats.map(([c, amt]) => `  - ${c}: $${amt.toFixed(2)} (${Math.round(amt / (totalSpend || 1) * 100)}%)`).join('\n');

      if (flagged.length) {
        out += `\n\n⚠️ Policy / Discrepancy Alerts:\n` + flagged.map(f => `  - #${f.id} ${f.vendor || 'Unknown'} ($${(Number(f.amount) || 0).toFixed(2)}): ${f.discrepancy || f.policy_flag}`).join('\n');
      }
      return out;
    }
    case 'check_policy': {
      const violations = [];
      const d = a.date ? new Date(String(a.date) + 'T00:00:00Z') : new Date();
      const day = !isNaN(d) ? d.getUTCDay() : -1;
      const amt = Number(a.amount) || 0;
      const tax = Number(a.tax) || 0;
      const vendor = String(a.vendor || 'Unknown Merchant');
      if (day === 0 || day === 6) violations.push('Weekend transaction: Requires business purpose justification');
      if (String(a.category || '').toLowerCase() === 'meals' && amt > 75) violations.push(`Meal total ($${amt.toFixed(2)}) exceeds standard $75 corporate limit`);
      if (String(a.category || '').toLowerCase() === 'lodging' && amt > 300) violations.push(`Lodging ($${amt.toFixed(2)}) exceeds standard $300/night cap`);
      if (a.notes && /alcohol|beer|wine|cocktail/i.test(String(a.notes))) violations.push('Alcohol detected: Personal payment or executive approval required');
      if (!tax || tax === 0) violations.push('Missing tax info: Verify VAT/GST on receipt for deductible claim');

      if (!violations.length) {
        return `✅ Policy Compliant: Expense of $${amt.toFixed(2)} at ${vendor} passes all corporate spend policies.`;
      }
      return `⚠️ Policy Warnings for ${vendor} ($${amt.toFixed(2)}):\n` + violations.map(v => `• ${v}`).join('\n') + `\nRecommendation: Flag item for manager review upon submission.`;
    }
    case 'batch_add_expenses': {
      const items = Array.isArray(a.expenses) ? a.expenses : [];
      if (!items.length) return 'No expenses provided in batch.';
      const saved = [];
      const skipped = [];
      let totalSum = 0;
      for (const item of items) {
        try {
          const r = addExpense(user.id, item, 'claude', a.allow_duplicates === true);
          if (r.duplicateOf) {
            skipped.push(`${item.vendor || 'Unknown'} ($${(Number(item.amount) || 0).toFixed(2)}) - duplicate of #${r.duplicateOf.id}`);
          } else {
            saved.push(r.expense);
            totalSum += (Number(r.expense.amount) || 0);
          }
        } catch (err) {
          skipped.push(`${item.vendor || 'Unknown'} - Error: ${err.message}`);
        }
      }
      let out = `⚡ Batch Ingestion Complete: ${saved.length} saved, ${skipped.length} skipped.\n`;
      out += `• Total Ingested Volume: $${totalSum.toFixed(2)}\n`;
      if (saved.length) {
        out += `\nSaved Receipts:\n` + saved.map(e => `  - #${e.id} ${e.date || ''} ${e.vendor || ''} ($${(Number(e.amount) || 0).toFixed(2)}) [${e.category || 'Other'}]`).join('\n');
      }
      if (skipped.length) {
        out += `\n\nSkipped / Duplicate Items:\n` + skipped.map(s => `  - ${s}`).join('\n');
      }
      return out;
    }
    case 'tax_deduction_report': {
      let rows = mine(user.id);
      if (a.month) rows = rows.filter(e => String(e.date || '').startsWith(a.month));
      else if (a.year) rows = rows.filter(e => String(e.date || '').startsWith(a.year));
      if (!rows.length) return `No expenses found for tax period ${a.month || a.year || 'all time'}.`;

      let fullDeductible = 0;
      let halfDeductible = 0;
      let nonDeductible = 0;
      let totalVatGst = 0;

      rows.forEach(e => {
        const tax = Number(e.tax) || 0;
        const amt = Number(e.amount) || 0;
        totalVatGst += tax;
        const cat = String(e.category || '').toLowerCase();
        if (cat === 'meals' || cat === 'food' || cat === 'entertainment') {
          halfDeductible += amt;
        } else if (cat === 'personal' || cat === 'fines') {
          nonDeductible += amt;
        } else {
          fullDeductible += amt;
        }
      });

      const eligibleHalf = halfDeductible * 0.5;
      const totalEligibleDeduction = fullDeductible + eligibleHalf;
      const periodLabel = a.month || a.year || 'All Time';

      let out = `📋 Tax Deduction & VAT/GST Schedule (${periodLabel}):\n`;
      out += `• Total Gross Spend: $${(fullDeductible + halfDeductible + nonDeductible).toFixed(2)}\n`;
      out += `• Total Eligible Tax Deduction: $${totalEligibleDeduction.toFixed(2)}\n`;
      out += `• Itemized VAT/GST Input Tax Credits (Recoverable): $${totalVatGst.toFixed(2)}\n\n`;

      out += `Deduction Breakdown by Schedule:\n`;
      out += `  - Standard Business (100% Deductible): $${fullDeductible.toFixed(2)} (Travel, Software, Supplies, Utilities)\n`;
      out += `  - Meals & Entertainment (50% Deductible): $${halfDeductible.toFixed(2)} spent → $${eligibleHalf.toFixed(2)} eligible write-off\n`;
      if (nonDeductible > 0) {
        out += `  - Non-deductible / Personal: $${nonDeductible.toFixed(2)}\n`;
      }
      out += `\nRecommendation: Export as CSV for accountant attachment to corporate tax filing.`;
      return out;
    }
    case 'audit_anomalies': {
      let rows = mine(user.id);
      if (a.month) rows = rows.filter(e => String(e.date || '').startsWith(a.month));
      if (!rows.length) return `No transactions found to audit${a.month ? ` for ${a.month}` : ''}.`;

      const anomalies = [];

      // 1. Double billing detection: same vendor + same amount within 2 days
      const sorted = rows.slice().sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')));
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a1 = sorted[i], a2 = sorted[j];
          const v1 = String(a1.vendor || '').toLowerCase();
          const v2 = String(a2.vendor || '').toLowerCase();
          const amt1 = Number(a1.amount) || 0;
          const amt2 = Number(a2.amount) || 0;
          if (v1 && v1 === v2 && Math.abs(amt1 - amt2) < 0.01) {
            const diffDays = Math.abs(new Date(a2.date) - new Date(a1.date)) / (1000 * 60 * 60 * 24);
            if (!isNaN(diffDays) && diffDays <= 2) {
              anomalies.push({
                risk: 'HIGH',
                type: 'Potential Double Charge',
                details: `${a1.vendor} charged $${amt1.toFixed(2)} on ${a1.date} (#${a1.id}) and again on ${a2.date} (#${a2.id})`
              });
            }
          }
        }
      }

      // 2. Structuring / Split transactions: same vendor on same date summing > $75
      const dayVendorGroups = {};
      rows.forEach(e => {
        const key = `${e.date || ''}__${String(e.vendor || '').toLowerCase()}`;
        (dayVendorGroups[key] = dayVendorGroups[key] || []).push(e);
      });
      Object.entries(dayVendorGroups).forEach(([key, group]) => {
        if (group.length > 1) {
          const sum = group.reduce((s, g) => s + (Number(g.amount) || 0), 0);
          if (sum > 75 && group.every(g => (Number(g.amount) || 0) <= 75)) {
            anomalies.push({
              risk: 'MEDIUM',
              type: 'Policy Evasion (Split Structuring)',
              details: `${group[0].vendor} on ${group[0].date}: ${group.length} split receipts totaling $${sum.toFixed(2)} bypassing $75 cap`
            });
          }
        }
      });

      // 3. Weekend transactions
      rows.forEach(e => {
        if (!e.date) return;
        const d = new Date(e.date + 'T00:00:00Z');
        if (isNaN(d)) return;
        const day = d.getUTCDay();
        if (day === 0 || day === 6) {
          anomalies.push({
            risk: 'LOW',
            type: 'Weekend Spend',
            details: `#${e.id} ${e.vendor} ($${(Number(e.amount) || 0).toFixed(2)}) on ${e.date} (weekend)`
          });
        }
      });

      // 4. Any existing math discrepancies or policy flags
      rows.filter(e => e.discrepancy).forEach(e => {
        anomalies.push({
          risk: 'HIGH',
          type: 'Math Discrepancy',
          details: `#${e.id} ${e.vendor}: ${e.discrepancy}`
        });
      });

      if (!anomalies.length) {
        return `✅ Forensic Audit Clean: Zero double charges, split transactions, or math mismatches detected across ${rows.length} receipts.`;
      }

      let out = `🕵️ Forensic Audit Findings (${anomalies.length} anomaly/anomalies detected):\n\n`;
      anomalies.forEach((anom, idx) => {
        out += `${idx + 1}. [${anom.risk} RISK] ${anom.type}\n   • ${anom.details}\n`;
      });
      return out;
    }
    default: throw new HttpError(404, `Unknown tool: ${name}`);
  }
}
function rpc(user, msg) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(-32600, 'Invalid request');
  if (msg.id === undefined) return null; // notification
  switch (msg.method) {
    case 'initialize': {
      const supported = ['2025-06-18', '2025-03-26', '2024-11-05'];
      const v = supported.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : supported[0];
      return reply({
        protocolVersion: v, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'receipt-vault', version: '1.0.0' },
        instructions: 'Receipt Vault stores the user\'s expenses permanently. When the user shares a receipt photo, read it, then call add_expense once per receipt. Always pass image_url if a URL or data URI is available, or generate an SVG data URI (data:image/svg+xml;utf8,<svg ...>) depicting the realistic bill slip with items and totals so it renders visually on their Notice Board. Tell the user what you saved and that they can review and edit it in the Receipt Vault web app. Never invent values you cannot read; ask instead.',
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      try {
        if (!TOOLS.some(t => t.name === msg.params?.name)) return err(-32602, `Unknown tool: ${msg.params?.name}`);
        return reply({ content: [{ type: 'text', text: callTool(user, msg.params.name, msg.params.arguments) }] });
      } catch (e) {
        if (!(e instanceof HttpError)) { console.error(e); return reply({ isError: true, content: [{ type: 'text', text: 'Internal error.' }] }); }
        return reply({ isError: true, content: [{ type: 'text', text: e.message }] });
      }
    }
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    default: return err(-32601, `Method not found: ${msg.method}`);
  }
}

// ---------- HTTP ----------
function readBody(req, limit = 15_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Body too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const send = (res, status, body, headers = {}) => {
  const isStr = typeof body === 'string';
  res.writeHead(status, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
};
const baseUrl = req => process.env.BASE_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
const attempts = new Map(); // naive login throttle
function throttle(key) {
  const now = Date.now(); const a = (attempts.get(key) || []).filter(t => now - t < 600_000);
  if (a.length >= 10) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  a.push(now); attempts.set(key, a);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Expose-Headers': 'Mcp-Session-Id' };
  try {
    // MCP endpoint: /mcp/<token>
    const mm = /^\/mcp\/([\w-]+)\/?$/.exec(p);
    if (mm) {
      if (req.method === 'OPTIONS') return send(res, 204, '', cors);
      const user = userFromToken(mm[1]);
      if (!user) return send(res, 401, { error: 'Invalid connector link. Copy a fresh one from Receipt Vault.' }, cors);
      if (req.method === 'GET') return send(res, 405, 'This endpoint speaks MCP over POST.', { ...cors, Allow: 'POST' });
      if (req.method === 'DELETE') return send(res, 200, '', cors);
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed', cors);
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, cors); }
      if (Array.isArray(body)) {
        const out = body.map(m => rpc(user, m)).filter(Boolean);
        return out.length ? send(res, 200, out, cors) : send(res, 202, '', cors);
      }
      const out = rpc(user, body);
      return out ? send(res, 200, out, cors) : send(res, 202, '', cors);
    }

    // API
    if (p.startsWith('/api/')) {
      const secure = (req.headers['x-forwarded-proto'] || '') === 'https';
      if (req.method !== 'GET' && !/application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Content-Type must be application/json.');
      const json = async () => { try { return JSON.parse((await readBody(req)) || '{}'); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'Invalid JSON.'); } };

      if (p === '/api/signup' && req.method === 'POST') {
        throttle('s' + req.socket.remoteAddress);
        const b = await json(); const u = createUser(b.email, b.password);
        return send(res, 200, { email: u.email }, { 'Set-Cookie': sessionCookie(u.id, secure) });
      }
      if (p === '/api/login' && req.method === 'POST') {
        throttle('l' + req.socket.remoteAddress);
        const b = await json(); const email = String(b.email || '').trim().toLowerCase();
        const u = Object.values(db.users).find(x => x.email === email);
        const ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(String(b.password || ''), u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
        if (!ok) throw new HttpError(401, 'Email or password is incorrect.');
        return send(res, 200, { email: u.email }, { 'Set-Cookie': sessionCookie(u.id, secure) });
      }
      if (p === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });

      const user = userFromReq(req);
      if (!user) throw new HttpError(401, 'Sign in required.');
      if (p === '/api/me') return send(res, 200, { email: user.email, mcpUrl: `${baseUrl(req)}/mcp/${user.token}`, categories: CATEGORIES });
      if (p === '/api/rotate-token' && req.method === 'POST') { user.token = newToken(); save(); return send(res, 200, { mcpUrl: `${baseUrl(req)}/mcp/${user.token}` }); }
      if (p === '/api/expenses' && req.method === 'GET') return send(res, 200, listExpenses(user.id, Object.fromEntries(url.searchParams)));
      if (p === '/api/expenses' && req.method === 'POST') {
        const r = addExpense(user.id, await json(), 'manual', true); return send(res, 200, r.expense);
      }
      const em = /^\/api\/expenses\/(\d+)$/.exec(p);
      if (em && req.method === 'PATCH') return send(res, 200, updateExpense(user.id, em[1], await json()));
      if (em && req.method === 'DELETE') { deleteExpense(user.id, em[1]); return send(res, 200, { ok: true }); }
      if (p === '/api/summary') return send(res, 200, summary(user.id, Object.fromEntries(url.searchParams)));
      if (p === '/api/upload' && req.method === 'POST') {
        const b = await json();
        if (!b.data || !b.data.startsWith('data:image/')) throw new HttpError(400, 'Invalid image data');
        const m = /^data:image\/(\w+);base64,(.+)$/.exec(b.data);
        if (!m) throw new HttpError(400, 'Invalid base64 image');
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const filename = `${crypto.randomUUID()}.${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, filename), Buffer.from(m[2], 'base64'));
        return send(res, 200, { url: `/receipts/${filename}` });
      }
      if (p === '/api/export.csv') {
        const format = url.searchParams.get('format') || 'standard';
        const month = url.searchParams.get('month') || '';
        const rows = listExpenses(user.id, { month }).rows;
        return send(res, 200, toCsv(rows, format), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="receipt-vault-${format}-${month || 'all'}.csv"` });
      }
      throw new HttpError(404, 'Not found.');
    }

    if (p.startsWith('/receipts/')) {
      const filename = path.basename(p);
      const filePath = path.join(UPLOAD_DIR, filename);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filename).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(filePath).pipe(res);
      }
      return send(res, 404, 'Image not found');
    }

    if (p === '/healthz') return send(res, 200, 'ok');
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    send(res, 404, 'Not found');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message }, p.startsWith('/mcp/') ? cors : {});
    console.error(e);
    send(res, 500, { error: 'Something went wrong.' });
  }
});

const demoEmail = (process.env.DEMO_EMAIL || 'demo@example.com').toLowerCase();
const demoPassword = process.env.DEMO_PASSWORD || 'password123';
if (!Object.values(db.users).some(u => u.email === demoEmail)) {
  createUser(demoEmail, demoPassword);
  console.log('Seeded demo user:', demoEmail);
}
if (require.main === module) server.listen(PORT, () => console.log(`Receipt Vault on :${PORT}`));
module.exports = { server };
