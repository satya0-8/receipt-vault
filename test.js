// End-to-end test: boots the server on a temp dir, drives it over real HTTP.
process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/rv-');
const assert = require('assert');
const { server } = require('./server.js');
let cookie = '', mcp = '';
const call = async (method, path, body, headers = {}) => {
  const r = await fetch('http://127.0.0.1:' + server.address().port + path, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};
const rpc = (id, method, params) => call('POST', mcp, { jsonrpc: '2.0', id, method, params });
const tool = async (name, args) => (await rpc(Math.random(), 'tools/call', { name, arguments: args })).body.result;

server.listen(0, async () => {
  try {
    assert.equal((await call('GET', '/api/me')).status, 401);
    assert.equal((await call('POST', '/api/signup', { email: 'a@b.co', password: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/signup', { email: 'a@b.co', password: 'longenough1' })).status, 200);
    const me = (await call('GET', '/api/me')).body;
    mcp = new URL(me.mcpUrl).pathname;

    // MCP handshake
    const init = (await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).body;
    assert.equal(init.result.serverInfo.name, 'receipt-vault');
    assert.equal((await call('POST', mcp, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const tools = (await rpc(2, 'tools/list')).body.result.tools.map(t => t.name);
    assert.deepEqual(tools, ['add_expense', 'list_expenses', 'update_expense', 'monthly_summary', 'spending_insights', 'check_policy', 'batch_add_expenses', 'tax_deduction_report', 'audit_anomalies']);
    assert.equal((await call('POST', '/mcp/wrongtoken', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);

    // add via Claude
    let r = await tool('add_expense', { vendor: 'Blue Bottle Coffee', date: '2026-11-08', amount: 14.5, tax: 1.1, currency: 'usd', category: 'meals', payment_method: 'Visa 4242' });
    assert.ok(!r.isError && /needs review/.test(r.content[0].text), r.content[0].text);
    // duplicate guard
    r = await tool('add_expense', { vendor: 'blue bottle coffee', date: '2026-11-08', amount: 14.5 });
    assert.ok(/duplicate/.test(r.content[0].text));
    // validation errors surface to Claude
    r = await tool('add_expense', { vendor: 'X', date: '2026-02-31', amount: 5 });
    assert.ok(r.isError && /date/.test(r.content[0].text));
    r = await tool('add_expense', { vendor: 'Uber', date: '2026-11-09', amount: 22, category: 'Transport' });
    assert.ok(!r.isError);

    // person edits in web app
    const list = (await call('GET', '/api/expenses?month=2026-11')).body;
    assert.equal(list.total, 2);
    const coffee = list.rows.find(x => x.vendor === 'Blue Bottle Coffee');
    assert.equal(coffee.reviewed, false);
    assert.equal(coffee.currency, 'USD');
    const up = await call('PATCH', '/api/expenses/' + coffee.id, { amount: '16.20', category: 'Groceries' });
    assert.equal(up.body.amount, 16.2); assert.equal(up.body.reviewed, true);
    assert.equal((await call('PATCH', '/api/expenses/' + coffee.id, { tax: 99 })).status, 400);

    // Claude sees the human's edit
    r = await tool('list_expenses', { search: 'blue' });
    assert.ok(/16\.20/.test(r.content[0].text) && /Groceries/.test(r.content[0].text));
    r = await tool('update_expense', { id: coffee.id, notes: 'client meeting' });
    assert.ok(!r.isError);
    r = await tool('monthly_summary', { month: '2026-11' });
    assert.ok(/38\.20/.test(r.content[0].text), r.content[0].text);

    // Test spending_insights and check_policy
    const insights = await tool('spending_insights', { month: '2026-11' });
    assert.ok(insights.content[0].text.includes('Financial & Policy Audit Insights'), insights.content[0].text);
    const policy = await tool('check_policy', { vendor: 'Fancy Steakhouse', amount: 150, category: 'Meals' });
    assert.ok(policy.content[0].text.includes('Policy Warnings'), policy.content[0].text);

    // Test new tools: batch_add_expenses, tax_deduction_report, audit_anomalies
    const batchRes = await tool('batch_add_expenses', {
      expenses: [
        { vendor: 'AWS Cloud', date: '2026-11-01', amount: 85.0, category: 'Software', tax: 8.5 },
        { vendor: 'Figma', date: '2026-11-02', amount: 15.0, category: 'Software', tax: 1.5 }
      ]
    });
    assert.ok(batchRes.content[0].text.includes('Batch Ingestion Complete: 2 saved'), batchRes.content[0].text);

    const taxRes = await tool('tax_deduction_report', { month: '2026-11' });
    assert.ok(taxRes.content[0].text.includes('Tax Deduction & VAT/GST Schedule'), taxRes.content[0].text);

    const auditRes = await tool('audit_anomalies', { month: '2026-11' });
    assert.ok(auditRes.content[0].text.includes('Forensic Audit'), auditRes.content[0].text);

    // CSV, with formula-injection guard and Volopay format
    await tool('add_expense', { vendor: '=HYPERLINK("evil")', date: '2026-11-10', amount: 1 });
    const csv = (await call('GET', '/api/export.csv?month=2026-11')).body;
    assert.ok(csv.startsWith('Date,Vendor') && csv.includes(`"'=HYPERLINK(""evil"")"`), csv);
    const vpCsv = (await call('GET', '/api/export.csv?format=volopay&month=2026-11')).body;
    assert.ok(vpCsv.startsWith('Transaction Date,Transaction ID'), vpCsv);

    // isolation between users
    const first = cookie; cookie = '';
    await call('POST', '/api/signup', { email: 'c@d.co', password: 'longenough2' });
    assert.equal((await call('GET', '/api/expenses')).body.total, 0);
    assert.equal((await call('PATCH', '/api/expenses/' + coffee.id, { notes: 'hack' })).status, 404);
    cookie = first;

    // token rotation kills the old link
    const old = mcp; const nu = (await call('POST', '/api/rotate-token', {})).body.mcpUrl;
    assert.equal((await call('POST', old, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
    mcp = new URL(nu).pathname; assert.equal((await rpc(1, 'ping')).status, 200);

    console.log('ALL TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  server.close();
});
