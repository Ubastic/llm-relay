'use strict';
// 并发分摊（LRU 选 key）与单次尝试超时回归自测：
//   1) 并发请求必须分摊到不同 key（最久未用优先），同一把 key 不被压出限流；
//   2) 上游“连上但永不吐数据”的挂死 key，必须在 attemptTimeoutSec 内被中止并换 key，
//      且按 transient 处理（key 保持 alive），客户端请求最终成功。
// 修复前行为：所有并发请求按数组顺序压第一把 key → 同步 429/冷却级联；
// 挂死 key 无超时 → 客户端无限等待。
// 运行：node tests/concurrency.test.js   （脚本自建 mock 上游，不碰真实 config.json）

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RELAY_PORT = 8795;
let failures = 0;
function ok(cond, name) { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failures++; }

const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); });

// mock 上游：按 key 统计在途数与成功数；超过该 key 的并发上限 → 429；
// sk-hang-* 收到请求后故意不响应（模拟“连接活着但不吐数据”）。
const inflight = {};   // key -> 当前在途数
const served = {};     // key -> 成功次数
let total429 = 0;
const LIMIT = { 'sk-a': 2, 'sk-b': 1 }; // key 前缀 -> 并发上限

const upstream = http.createServer(async (req, res) => {
  const key = String(req.headers['authorization'] || '').replace(/^Bearer\s*/i, '');
  await readBody(req); // 读完请求体再响应
  if (key.startsWith('sk-hang')) return; // 永不响应
  const prefix = key.slice(0, 4);
  const limit = LIMIT[prefix] || 1;
  inflight[key] = (inflight[key] || 0) + 1;
  if (inflight[key] > limit) {
    inflight[key]--; total429++;
    res.writeHead(429, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'rate limit (concurrent>' + limit + ')', type: 'rate_limit_error' } }));
  }
  setTimeout(() => {
    inflight[key]--;
    served[key] = (served[key] || 0) + 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok(' + key.slice(-4) + ')' } }] }));
  }, 150);
});

const chat = (model) => fetch('http://127.0.0.1:' + RELAY_PORT + '/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  signal: AbortSignal.timeout(8000), // 修复前的挂死行为在这里以超时失败，而不是卡死测试
});

(async () => {
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const key = (k) => ({ key: k, status: 'alive', lastError: '', lastUsed: 0, failCount: 0, cooldownUntil: 0 });
  const cfg = {
    port: RELAY_PORT, host: '127.0.0.1', proxyKey: '', proxyUrl: '',
    rateCooldownSec: 3, attemptTimeoutSec: 2,
    platforms: [
      { id: 'pa', name: 'mockA', baseUrl: 'http://127.0.0.1:' + upPort, protocol: 'openai', models: ['mA'], testModel: '', proxy: '',
        keys: [key('sk-hang-0001'), key('sk-a-1111'), key('sk-a-2222'), key('sk-a-3333'), key('sk-a-4444'), key('sk-a-5555')] },
      { id: 'pb', name: 'mockB', baseUrl: 'http://127.0.0.1:' + upPort, protocol: 'openai', models: ['mB'], testModel: '', proxy: '',
        keys: [key('sk-b-1111'), key('sk-b-2222'), key('sk-b-3333')] },
    ],
  };
  const cfgPath = path.join(os.tmpdir(), 'llm-relay-concurrency-test-' + Date.now() + '.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const child = spawn(process.execPath, ['server.js', '--port', String(RELAY_PORT)], { cwd: ROOT, env: { ...process.env, RELAY_CONFIG: cfgPath }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', d => process.stdout.write('[relay!] ' + d));
  const kill = () => { try { child.kill(); upstream.close(); } catch {} };
  process.on('exit', kill);

  try {
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) { try { ready = (await fetch('http://127.0.0.1:' + RELAY_PORT + '/admin/api/state')).ok; } catch {} if (!ready) await new Promise(r => setTimeout(r, 200)); }
    if (!ready) throw new Error('中转实例未就绪');

    // ---- 测试 1：3 路并发（mB，每 key 并发上限 1）→ 必须分摊到 3 把不同 key，零限流 ----
    console.log('测试 1：LRU 并发分摊（3 路并发 / 3 key / 每 key 上限 1）');
    const t1 = Date.now();
    const rs = await Promise.all([chat('mB'), chat('mB'), chat('mB')]);
    const bodies = await Promise.all(rs.map(r => r.text()));
    ok(rs.every(r => r.status === 200), '3 路并发全部成功');
    const usage = ['sk-b-1111', 'sk-b-2222', 'sk-b-3333'].map(k => served[k] || 0);
    ok(usage.join(',') === '1,1,1', '每把 key 恰好服务 1 次（分摊生效），实际 ' + usage.join(','));
    ok(total429 === 0, '上游零限流（修复前会全部压第一把 key）');
    ok(Date.now() - t1 < 5000, '总耗时正常（<5s）');

    // ---- 测试 2：10 路并发 + 一把挂死 key（mA）→ 挂死 key 被限时中止，其余分摊成功 ----
    console.log('测试 2：挂死 key + 10 路并发（5 把好 key / 每 key 上限 2）');
    const t2 = Date.now();
    const rs2 = await Promise.all(Array.from({ length: 10 }, () => chat('mA')));
    const bodies2 = await Promise.all(rs2.map(r => r.text()));
    ok(rs2.every(r => r.status === 200), '10 路并发全部成功（含撞上挂死 key 的那路）');
    ok(bodies2.every(b => b.includes('"content"')), '响应内容完整');
    ok(total429 === 0, '全程上游零限流');
    const goodUse = ['sk-a-1111', 'sk-a-2222', 'sk-a-3333', 'sk-a-4444', 'sk-a-5555'].map(k => served[k] || 0);
    ok(goodUse.every(n => n >= 1), '5 把好 key 全部被用到，分布 ' + goodUse.join(','));
    ok(goodUse.reduce((a, b) => a + b, 0) === 10, '成功总数 = 10');
    const el2 = Date.now() - t2;
    ok(el2 < 6000, '挂死 key 被 attemptTimeoutSec=2 限时（总耗时 ' + el2 + 'ms < 6s；修复前会无限等待）');

    // ---- 挂死 key 的状态：transient 计一次失败但保持 alive，不误杀 ----
    const st = await (await fetch('http://127.0.0.1:' + RELAY_PORT + '/admin/api/state')).json();
    const hang = st.platforms[0].keys[0];
    ok(hang.status === 'alive', '挂死 key 按 transient 处理，保持 alive');
    ok(String(hang.lastError).includes('尝试超时'), '挂死 key 记录了尝试超时原因: ' + hang.lastError);

    console.log(failures === 0 ? '\n全部通过 ✓' : '\n失败 ' + failures + ' 项');
    process.exitCode = failures === 0 ? 0 : 1;
  } catch (e) {
    console.error('测试出错:', e);
    process.exitCode = 1;
  } finally {
    kill();
  }
})();
