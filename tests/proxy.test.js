'use strict';
// 出站代理一键自测：本脚本自建 mock 上游（http + https）、HTTP CONNECT 代理（带连接计数）、
// 带账号密码的 SOCKS5 代理（带连接计数），再用独立临时配置起一个中转实例，
// 验证：direct 强制直连、全局 HTTP 代理、平台 SOCKS5 代理（含认证）、流式经代理、
// https 经代理隧道+TLS、坏代理时报错信息可见。
// 运行：node tests/proxy.test.js   （无需 tests/mock.js，不碰真实 config.json）

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RELAY_PORT = 8791;
let failures = 0;
function ok(cond, name) { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failures++; }

function readBody(req) {
  return new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); });
}
function json(res, status, obj) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

/* ---------- mock 上游（OpenAI 协议：非流式 + SSE） ---------- */
function mockHandler(req, res) {
  return (async () => {
    if (req.method === 'GET' && req.url.includes('/models')) return json(res, 200, { object: 'list', data: [{ id: 'mock-model', object: 'model' }] });
    if (req.method !== 'POST' || !req.url.includes('/chat/completions')) return json(res, 404, { error: { message: 'mock: 未知路径 ' + req.url } });
    const body = JSON.parse((await readBody(req)) || '{}');
    const key = String(req.headers['authorization'] || '').replace(/^Bearer\s*/i, '');
    if (key.includes('dead')) return json(res, 402, { code: 'INSUFFICIENT_BALANCE', message: '余额不足' });
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const t of ['你', '好', '呀']) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    json(res, 200, { id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok(' + body.model + ')' } }] });
  })().catch(e => json(res, 500, { error: { message: e.message } }));
}

/* ---------- HTTP 代理：只处理 CONNECT，带连接计数 ---------- */
function startHttpProxy() {
  let conns = 0;
  const srv = http.createServer((req, res) => { res.writeHead(405); res.end('proxy: CONNECT only'); });
  srv.on('connect', (req, client, head) => {
    const i = req.url.lastIndexOf(':');
    const up = net.connect(Number(req.url.slice(i + 1)), req.url.slice(0, i), () => {
      conns++;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(client); client.pipe(up);
    });
    up.on('error', () => client.end());
    client.on('error', () => up.destroy());
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, get conns() { return conns; } })));
}

/* ---------- SOCKS5 代理：无认证+用户名/密码两种方式，带连接计数 ---------- */
function startSocks5() {
  let conns = 0;
  const USER = 'tester', PASS = 'secret';
  const srv = net.createServer(sock => {
    let buf = Buffer.alloc(0), stage = 0;
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      try {
        if (stage === 0) {
          if (buf.length < 2) return;
          const n = buf[1];
          if (buf.length < 2 + n) return;
          const methods = [...buf.subarray(2, 2 + n)];
          buf = buf.subarray(2 + n);
          stage = 1;
          if (methods.includes(2)) { sock.write(Buffer.from([5, 2])); stage = 0.5; } // 要求认证
          else sock.write(Buffer.from([5, 0]));
          if (stage === 1) return proceed();
          return;
        }
        if (stage === 0.5) { // 用户名/密码子协商
          if (buf.length < 2) return;
          const ul = buf[1];
          if (buf.length < 2 + ul + 1) return;
          const pl = buf[2 + ul];
          if (buf.length < 3 + ul + pl) return;
          const u = buf.subarray(2, 2 + ul).toString(), p = buf.subarray(3 + ul, 3 + ul + pl).toString();
          buf = buf.subarray(3 + ul + pl);
          sock.write(Buffer.from([1, u === USER && p === PASS ? 0 : 1]));
          if (u !== USER || p !== PASS) { sock.end(); return; }
          stage = 1;
          return proceed();
        }
        if (stage === 1) return proceed();
      } catch (e) { sock.end(); }
    };
    let target = null, leftover = Buffer.alloc(0);
    const proceed = () => { // 解析 CONNECT 请求并建立隧道
      if (target) return;
      if (buf.length < 4) return;
      const atyp = buf[3];
      let host, need;
      if (atyp === 1) {
        if (buf.length < 10) return;
        host = [...buf.subarray(4, 8)].join('.'); need = 10;
      } else if (atyp === 3) {
        const l = buf[4];
        if (buf.length < 5 + l + 2) return;
        host = buf.subarray(5, 5 + l).toString(); need = 5 + l + 2;
      } else if (atyp === 4) {
        if (buf.length < 22) return;
        host = [...buf.subarray(4, 20)].map(b => b.toString(16)).join(':'); need = 22;
      } else { sock.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      const port = buf.readUInt16BE(need - 2);
      leftover = buf.subarray(need); // 可能与请求同包到达的首批数据
      buf = Buffer.alloc(0);
      target = net.connect(port, host, () => {
        conns++;
        sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        sock.off('data', onData);
        if (leftover.length) target.write(leftover);
        target.pipe(sock); sock.pipe(target);
      });
      target.on('error', () => sock.end());
    };
    sock.on('data', onData);
    sock.on('error', () => { if (target) target.destroy(); });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, get conns() { return conns; } })));
}

/* ---------- 中转实例（独立临时配置） ---------- */
function startRelay(cfg) {
  const cfgPath = path.join(os.tmpdir(), 'llm-relay-proxy-test-' + Date.now() + '.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const child = spawn(process.execPath, ['server.js', '--port', String(RELAY_PORT)], {
    cwd: ROOT,
    env: { ...process.env, RELAY_CONFIG: cfgPath, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.stdout.write('[relay] ' + d));
  child.stderr.on('data', d => process.stdout.write('[relay!] ' + d));
  return { child, cfgPath };
}

async function relayJson(p, body) {
  const r = await fetch('http://127.0.0.1:' + RELAY_PORT + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
  });
  return { status: r.status, text: await r.text() };
}

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch('http://127.0.0.1:' + RELAY_PORT + '/admin/api/state'); if (r.ok) return; } catch {}
    await new Promise(r2 => setTimeout(r2, 200));
  }
  throw new Error('中转实例未就绪');
}

(async () => {
  const httpProxy = await startHttpProxy();
  const socks = await startSocks5();
  const mock = http.createServer(mockHandler);
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const httpsMock = https.createServer({ key: fs.readFileSync(path.join(__dirname, 'fixtures', 'key.pem')), cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'cert.pem')) }, mockHandler);
  await new Promise(r => httpsMock.listen(0, '127.0.0.1', r));
  const upPort = mock.address().port, upHttpsPort = httpsMock.address().port;

  const plat = (name, models, proxy, baseUrl) => ({
    id: 'p_' + name, name, baseUrl: baseUrl || ('http://127.0.0.1:' + upPort), protocol: 'openai',
    models, testModel: '', proxy,
    keys: [{ key: 'sk-ok', status: 'alive', lastError: '', lastUsed: 0, failCount: 0, cooldownUntil: 0 }],
  });
  const cfg = {
    port: RELAY_PORT, host: '127.0.0.1', proxyKey: '', proxyUrl: 'http://127.0.0.1:' + httpProxy.port, rateCooldownSec: 5,
    platforms: [
      plat('直连覆盖', ['m-direct'], 'direct'),
      plat('全局http', ['m-http'], ''),
      plat('socks认证', ['m-socks'], 'socks5://tester:secret@127.0.0.1:' + socks.port),
      plat('坏代理', ['m-broken'], 'http://127.0.0.1:1'),
      plat('https经代理', ['m-https'], '', 'https://127.0.0.1:' + upHttpsPort),
    ],
  };
  const relay = startRelay(cfg);

  try {
    await waitReady();
    console.log('mock 上游 :' + upPort + '（http） :' + upHttpsPort + '（https） · HTTP 代理 :' + httpProxy.port + ' · SOCKS5 代理 :' + socks.port);

    const c0 = httpProxy.conns, s0 = socks.conns;
    let r = await relayJson({ model: 'm-direct', messages: [{ role: 'user', content: 'hi' }] });
    ok(r.status === 200 && r.text.includes('ok(m-direct)'), 'direct 覆盖全局代理，直连成功');
    ok(httpProxy.conns === c0 && socks.conns === s0, 'direct 确实未经过任何代理');

    r = await relayJson({ model: 'm-http', messages: [{ role: 'user', content: 'hi' }] });
    ok(r.status === 200 && r.text.includes('ok(m-http)'), '未设代理的平台走全局 HTTP 代理成功');
    ok(httpProxy.conns > c0, 'HTTP 代理连接计数增加（确实走了代理）');

    const h1 = httpProxy.conns;
    r = await relayJson({ model: 'm-socks', messages: [{ role: 'user', content: 'hi' }] });
    ok(r.status === 200 && r.text.includes('ok(m-socks)'), 'SOCKS5 代理（含用户名/密码认证）成功');
    ok(socks.conns > s0 && httpProxy.conns === h1, 'SOCKS5 代理连接计数增加');

    r = await relayJson({ model: 'm-https', messages: [{ role: 'user', content: 'hi' }] });
    ok(r.status === 200 && r.text.includes('ok(m-https)'), 'https 上游经 HTTP 代理 CONNECT 隧道 + TLS 成功');

    // 流式经 SOCKS5 代理
    r = await relayJson({ model: 'm-socks', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const sseText = r.text;
    const content = sseText.split('\n').filter(l => l.startsWith('data:') && !l.includes('[DONE]'))
      .map(l => { try { return (JSON.parse(l.slice(5).trim()).choices[0].delta.content) || ''; } catch { return ''; } }).join('');
    ok(r.status === 200 && content === '你好呀', '流式请求经 SOCKS5 代理完成（SSE 转发完整：' + content + '）');

    r = await relayJson({ model: 'm-broken', messages: [{ role: 'user', content: 'hi' }] });
    ok(r.status === 502 && r.text.includes('代理'), '坏代理返回 502 且错误信息含「代理」: ' + JSON.parse(r.text).error.message.split('\n')[0]);

    r = await fetch('http://127.0.0.1:' + RELAY_PORT + '/v1/models');
    const mj = await r.json();
    ok(r.status === 200 && (mj.data || []).some(m => m.id === 'm-direct'), '/v1/models 聚合正常（经代理拉取上游模型列表）');

    console.log(failures ? '\n有 ' + failures + ' 项失败' : '\n全部通过 ✓');
  } catch (e) {
    failures++;
    console.error('测试执行异常:', e);
  } finally {
    relay.child.kill();
    await new Promise(r => relay.child.on('exit', r));
    try { fs.unlinkSync(relay.cfgPath); } catch {}
    httpProxy.srv.close(); socks.srv.close(); mock.close(); httpsMock.close();
    process.exit(failures ? 1 : 0);
  }
})();
