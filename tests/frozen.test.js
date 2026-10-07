'use strict';
// 账号冻结类错误回归自测：上游返回 400「计费账户已被冻结」这类账号级永久错误时，
// key 必须被标记为无效并自动换下一个 key，而不是按 bad_request 原样透传、key 保持可用。
// 运行：node tests/frozen.test.js   （脚本自建 mock 上游，不碰真实 config.json）

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RELAY_PORT = 8794;
let failures = 0;
function ok(cond, name) { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failures++; }

const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); });

// key 含 frozen → 400 计费账户已被冻结；其他 key 正常
const upstream = http.createServer(async (req, res) => {
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    const key = String(req.headers['authorization'] || '').replace(/^Bearer\s*/i, '');
    if (key.includes('frozen')) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ message: '计费账户已被冻结' })); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok(' + key.slice(-4) + ')' } }] }));
  } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: { message: e.message } })); }
});

(async () => {
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const key = (k, status) => ({ key: k, status: status || 'alive', lastError: '', lastUsed: 0, failCount: 0, cooldownUntil: 0 });
  const cfg = {
    port: RELAY_PORT, host: '127.0.0.1', proxyKey: '', proxyUrl: '', rateCooldownSec: 5,
    platforms: [{ id: 'p1', name: 'mock', baseUrl: 'http://127.0.0.1:' + upPort, protocol: 'openai', models: ['m1'], testModel: '', proxy: '', keys: [key('sk-frozen-aaaa'), key('sk-good-bbbb')] }],
  };
  const cfgPath = path.join(os.tmpdir(), 'llm-relay-frozen-test-' + Date.now() + '.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const child = spawn(process.execPath, ['server.js', '--port', String(RELAY_PORT)], { cwd: ROOT, env: { ...process.env, RELAY_CONFIG: cfgPath }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', d => process.stdout.write('[relay!] ' + d));

  try {
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) { try { ready = (await fetch('http://127.0.0.1:' + RELAY_PORT + '/admin/api/state')).ok; } catch {} if (!ready) await new Promise(r => setTimeout(r, 200)); }
    if (!ready) throw new Error('中转实例未就绪');

    // 修复前行为：400 原样透传给客户端、key 保持可用 → 客户端永远失败
    const r = await fetch('http://127.0.0.1:' + RELAY_PORT + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }) });
    const txt = await r.text();
    ok(r.status === 200 && txt.includes('ok(bbbb)'), '冻结 key 自动跳过，正常 key 完成请求');
    ok(!txt.includes('冻结'), '错误没有透传给客户端');

    const st = await (await fetch('http://127.0.0.1:' + RELAY_PORT + '/admin/api/state')).json();
    const frozen = st.platforms[0].keys[0], good = st.platforms[0].keys[1];
    ok(frozen.status === 'invalid' && frozen.lastError.includes('计费账户已被冻结'), '冻结 key 已标记无效并记录原因');
    ok(good.status === 'alive', '正常 key 不受影响');

    // 第二次请求不再碰冻结 key
    const r2 = await fetch('http://127.0.0.1:' + RELAY_PORT + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }) });
    const t2 = await r2.text();
    ok(r2.status === 200 && t2.includes('ok(bbbb)'), '后续请求直接走正常 key');

    console.log(failures ? '\n有 ' + failures + ' 项失败' : '\n全部通过 ✓');
  } catch (e) {
    failures++;
    console.error('测试执行异常:', e);
  } finally {
    child.kill();
    await new Promise(r => child.on('exit', r));
    try { fs.unlinkSync(cfgPath); } catch {}
    upstream.close();
    process.exit(failures ? 1 : 0);
  }
})();
