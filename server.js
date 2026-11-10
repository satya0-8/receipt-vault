// Receipt Vault: web app + MCP server in one process. Zero dependencies, zero AI.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'vault.json');
const CATEGORIES = ['Meals', 'Groceries', 'Travel', 'Lodging', 'Transport', 'Software', 'Office Supplies', 'Utilities', 'Entertainment', 'Health', 'Other'];

// ---------- storage (JSON file, atomic writes) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
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

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
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
    const d = String(input.date ?? '').trim();
    if (!validDate(d)) throw new HttpError(400, 'date must be a real date in YYYY-MM-DD format.');
    out.date = d;
  }
  if (has('amount') || !partial) {
    const a = Number(input.amount);
    if (!Number.isFinite(a) || a < 0) throw new HttpError(400, 'amount must be a non-negative number (the total paid, including tax).');
    out.amount = round2(a);
  }
  if (has('tax')) {
    const t = Number(input.tax);
    if (!Number.isFinite(t) || t < 0) throw new HttpError(400, 'tax must be a non-negative number.');
    out.tax = round2(t);
  } else if (!partial) out.tax = 0;
  if (has('currency') || !partial) {
    const c = String(input.currency ?? 'USD').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw new HttpError(400, 'currency must be a 3-letter ISO code such as USD, INR, EUR.');
    out.currency = c;
  }
  if (has('category') || !partial) {
    const raw = String(input.category ?? 'Other').trim();
    const match = CATEGORIES.find(c => c.toLowerCase() === raw.toLowerCase());
    if (!match) throw new HttpError(400, `category must be one of: ${CATEGORIES.join(', ')}.`);
    out.category = match;
  }
  if (has('payment_method')) out.payment_method = String(input.payment_method).trim().slice(0, 60);
  if (has('notes')) out.notes = String(input.notes).trim().slice(0, 500);
  if (out.amount !== undefined && out.tax !== undefined && out.tax > out.amount) throw new HttpError(400, 'tax cannot be larger than the total amount.');
  return out;
}
const mine = uid => db.expenses.filter(e => e.uid === uid);
const pub = ({ uid, ...e }) => e;

function addExpense(uid, input, source, allowDup) {
  const f = normalize(input, false);
  const dup = mine(uid).find(e => e.vendor.toLowerCase() === f.vendor.toLowerCase() && e.date === f.date && e.amount === f.amount && e.currency === f.currency);
  if (dup && !allowDup) return { duplicateOf: pub(dup) };
  const now = new Date().toISOString();
  const e = { id: db.nextId++, uid, payment_method: '', notes: '', ...f, source, reviewed: source !== 'claude', created: now, updated: now };
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
function listExpenses(uid, { month, search, category, needs_review, limit } = {}) {
  let rows = mine(uid);
  if (month) rows = rows.filter(e => e.date.startsWith(month));
  if (category) rows = rows.filter(e => e.category.toLowerCase() === String(category).toLowerCase());
  if (needs_review !== undefined && needs_review !== '') rows = rows.filter(e => e.reviewed === !(needs_review === true || needs_review === 'true'));
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter(e => [e.vendor, e.notes, e.category, e.payment_method].join(' ').toLowerCase().includes(q));
  }
  rows = rows.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const total = rows.length;
  if (limit) rows = rows.slice(0, Math.min(Number(limit) || 50, 500));
  return { total, rows: rows.map(pub) };
}
function summary(uid, month) {
  const rows = mine(uid).filter(e => !month || e.date.startsWith(month));
  const byCur = {};
  for (const e of rows) {
    const c = (byCur[e.currency] ||= { currency: e.currency, total: 0, tax: 0, count: 0, byCategory: {} });
    c.total += e.amount; c.tax += e.tax; c.count++;
    c.byCategory[e.category] = (c.byCategory[e.category] || 0) + e.amount;
  }
  const out = Object.values(byCur).map(c => ({
    currency: c.currency, total: round2(c.total), tax: round2(c.tax), net: round2(c.total - c.tax), count: c.count,
    byCategory: Object.entries(c.byCategory).map(([category, amount]) => ({ category, amount: round2(amount) })).sort((a, b) => b.amount - a.amount),
  }));
  return { month: month || 'all', needsReview: rows.filter(e => !e.reviewed).length, totals: out };
}
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // block spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) {
  const head = ['Date', 'Vendor', 'Category', 'Currency', 'Total', 'Tax', 'Net', 'Payment method', 'Notes', 'ID'];
  const lines = [head.join(',')].concat(rows.slice().sort((a, b) => a.date.localeCompare(b.date)).map(e =>
    [e.date, e.vendor, e.category, e.currency, e.amount.toFixed(2), e.tax.toFixed(2), (e.amount - e.tax).toFixed(2), e.payment_method, e.notes, e.id].map(csvCell).join(',')));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// ---------- MCP (Streamable HTTP, JSON-RPC 2.0) ----------
const today = () => new Date().toISOString().slice(0, 10);
const catEnum = { type: 'string', enum: CATEGORIES };
const TOOLS = [
  {
    name: 'add_expense',
    description: 'Save one expense from a receipt into the user\'s Receipt Vault ledger. Read the receipt image yourself, then call this once per receipt with the values you read. Rejects likely duplicates (same vendor, date, amount) unless allow_duplicate is true. Saved items are marked "needs review" until the user confirms them in the web app.',
    inputSchema: {
      type: 'object', required: ['vendor', 'date', 'amount'],
      properties: {
        vendor: { type: 'string', description: 'Merchant name as printed on the receipt.' },
        date: { type: 'string', description: 'Purchase date, YYYY-MM-DD. If the year is missing, assume the current year (' + today().slice(0, 4) + ').' },
        amount: { type: 'number', description: 'Grand total paid, INCLUDING tax and tip.' },
        currency: { type: 'string', description: '3-letter ISO code, e.g. USD, INR, EUR. Default USD.' },
        category: { ...catEnum, description: 'Best-fit category.' },
        tax: { type: 'number', description: 'Total tax/VAT/GST shown on the receipt. 0 if none shown.' },
        payment_method: { type: 'string', description: 'e.g. "Visa 4242", "Cash", "UPI". Optional.' },
        notes: { type: 'string', description: 'Short note, e.g. what was bought or the business purpose. Optional.' },
        allow_duplicate: { type: 'boolean', description: 'Set true only if the user confirmed this is a separate, identical purchase.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'list_expenses',
    description: 'Search and list saved expenses, newest first. Use it to answer questions about past spending or to find an expense id before updating it.',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'YYYY-MM, e.g. 2026-11.' },
        search: { type: 'string', description: 'Matches vendor, notes, category, payment method.' },
        category: catEnum,
        needs_review: { type: 'boolean', description: 'true = only items the user has not confirmed yet.' },
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
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'monthly_summary',
    description: 'Totals for a month (or all time if month is omitted): spend, tax, net and count per currency, with a category breakdown. Also reports how many items still need review.',
    inputSchema: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM. Defaults to the current month (' + today().slice(0, 7) + ').' } } },
    annotations: { readOnlyHint: true },
  },
];
const fmt = (e) => `#${e.id} ${e.date} ${e.vendor} | ${e.category} | ${e.currency} ${e.amount.toFixed(2)} (tax ${e.tax.toFixed(2)})${e.reviewed ? '' : ' [needs review]'}`;

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
      const month = a.month || today().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'month must be YYYY-MM.');
      const s = summary(user.id, month);
      if (!s.totals.length) return `No expenses recorded for ${month}.`;
      return `Summary for ${month} (${s.needsReview} item(s) still need review):\n` + s.totals.map(t =>
        `${t.currency}: total ${t.total.toFixed(2)}, tax ${t.tax.toFixed(2)}, net ${t.net.toFixed(2)}, ${t.count} receipts\n` +
        t.byCategory.map(c => `  - ${c.category}: ${c.amount.toFixed(2)}`).join('\n')).join('\n');
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
        instructions: 'Receipt Vault stores the user\'s expenses permanently. When the user shares a receipt photo, read it, then call add_expense once per receipt. Tell the user what you saved and that they can review and edit it in the Receipt Vault web app. Never invent values you cannot read; ask instead.',
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
function readBody(req, limit = 200_000) {
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
      if (p === '/api/summary') return send(res, 200, summary(user.id, url.searchParams.get('month') || ''));
      if (p === '/api/export.csv') {
        const rows = listExpenses(user.id, { month: url.searchParams.get('month') || '' }).rows;
        return send(res, 200, toCsv(rows), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="receipt-vault-${url.searchParams.get('month') || 'all'}.csv"` });
      }
      throw new HttpError(404, 'Not found.');
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
