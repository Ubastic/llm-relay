'use strict';
// 配置导出/导入 + 管理页密码保护 回归自测：
//   实例 A（无密码）    ：export 返回完整配置；import 覆盖平台与设置；非法导入 400；
//                         无 proxyKey 时管理接口直接可访问（原行为）
//   实例 B（RELAY_ADMIN_PASSWORD 开启，且配置了 proxyKey）：
//                         GET / 未登录 → 登录页；登录成功发 Cookie；带 Cookie 看到管理页；
//                         管理接口 Cookie 或 x-admin-key 均可通过；/v1/models 不受密码门影响
// 运行：node tests/admin.test.js   （独立临时配置，不碰真实 config.json）

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8798;
let failures = 0;
function ok(cond, name) { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failures++; }

const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); });

function startRelay(cfg, extraEnv) {
  const cfgPath = path.join(os.tmpdir(), 'llm-relay-admin-test-' + Date.now() + '.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const child = spawn(process.execPath, ['server.js', '--port', String(PORT)], { cwd: ROOT, env: { ...process.env, RELAY_CONFIG: cfgPath, ...(extraEnv || {}) }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', d => process.stdout.write('[relay!] ' + d));
  return { child, cfgPath };
}
async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/admin/api/state'); if (r.status === 200 || r.status === 401) return true; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}
async function stopRelay(relay) {
  relay.child.kill();
  await new Promise(r => relay.child.on('exit', r));
  try { fs.unlinkSync(relay.cfgPath); } catch {}
}
const key = (k, status) => ({ key: k, status: status || 'alive', lastError: '', lastUsed: 0, failCount: 0, cooldownUntil: 0 });

(async () => {
  /* ---------- 实例 A：无密码门（原行为） ---------- */
  const platA = id => ({ id, name: '平台' + id, baseUrl: 'http://127.0.0.1:9/' + id, protocol: 'openai', models: ['m-' + id], testModel: '', proxy: '', keys: [key('sk-' + id + '-1')] });
  let relay = startRelay({ port: PORT, host: '127.0.0.1', proxyKey: '', proxyUrl: '', rateCooldownSec: 60, platforms: [platA('a1')] });
  try {
    if (!await waitReady()) throw new Error('实例 A 未就绪');
    const B = 'http://127.0.0.1:' + PORT;

    let r = await fetch(B + '/admin/api/config/export');
    const exported = await r.json();
    ok(r.status === 200 && Array.isArray(exported.platforms) && exported.platforms.length === 1 && exported.platforms[0].keys[0].key === 'sk-a1-1', 'export 返回完整配置（平台+key）');

    const importCfg = {
      proxyKey: '', proxyUrl: 'socks5://127.0.0.1:1080', rateCooldownSec: 30,
      platforms: [
        platA('b1'),
        { name: '文本key导入', baseUrl: 'http://127.0.0.1:9/b2', protocol: 'openai', models: [], keys: ['sk-plain-1', { key: 'sk-obj-1', status: 'invalid' }, { key: '   ', status: 'alive' }] },
      ],
    };
    r = await fetch(B + '/admin/api/config/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(importCfg) });
    const ij = await r.json();
    ok(r.status === 200 && ij.ok && ij.platforms === 2 && ij.keys === 3, 'import 成功且统计正确（2 平台 / 3 key，字符串与对象 key 均收，空 key 丢弃）');

    const st = await (await fetch(B + '/admin/api/state')).json();
    ok(st.platforms.length === 2 && st.platforms[0].name === '平台b1' && st.proxyUrl === 'socks5://127.0.0.1:1080', '导入后 state 已切换（平台/全局代理生效）');
    const b2 = st.platforms.find(p => p.name === '文本key导入');
    if (!b2) { ok(false, '导入的平台存在'); ok(false, 'key 状态归一化'); ok(false, '非法 id 去重'); }
    else {
      ok(b2.keys.length === 2 && b2.keys[0].status === 'alive' && b2.keys[1].status === 'invalid', 'key 状态归一化（字符串→alive，对象保留 invalid，空 key 丢弃）');
      ok(new Set(st.platforms.map(p => p.id)).size === 2, '平台 id 唯一');
    }

    r = await fetch(B + '/admin/api/config/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ foo: 1 }) });
    ok(r.status === 400, '缺 platforms 的导入返回 400');
    r = await fetch(B + '/admin/api/config/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platforms: [{ name: 'x', baseUrl: '' }] }) });
    ok(r.status === 400, '平台缺 Base URL 的导入返回 400');

    console.log(failures ? '\n实例 A 有失败项' : '\n实例 A（导出/导入）全部通过 ✓');
  } catch (e) {
    failures++;
    console.error('实例 A 执行异常:', e);
  } finally {
    await stopRelay(relay);
  }
  if (failures) { process.exit(1); return; }
  failures = 0;
  console.log('');

  /* ---------- 实例 B：密码门开启 + proxyKey 同时设置 ---------- */
  relay = startRelay({ port: PORT, host: '127.0.0.1', proxyKey: 'sk-admin-x', proxyUrl: '', rateCooldownSec: 60, platforms: [] }, { RELAY_ADMIN_PASSWORD: 'test-pw-123' });
  try {
    if (!await waitReady()) throw new Error('实例 B 未就绪');
    const B = 'http://127.0.0.1:' + PORT;

    let r = await fetch(B + '/');
    let html = await r.text();
    ok(html.includes('id="pw"') && !html.includes('id="platforms"'), '未登录访问管理页 → 返回登录页');
    r = await fetch(B + '/admin/api/state');
    ok(r.status === 401, '未登录调用管理接口 → 401');

    r = await fetch(B + '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
    ok(r.status === 401, '错误密码 → 401');
    r = await fetch(B + '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-pw-123' }) });
    const setCookie = r.headers.get('set-cookie') || '';
    ok(r.status === 200 && setCookie.includes('relay_auth='), '正确密码 → 200 并下发 Cookie');
    const cookie = setCookie.split(';')[0];

    r = await fetch(B + '/', { headers: { cookie } });
    html = await r.text();
    ok(html.includes('id="platforms"') && !html.includes('id="pw"'), '带 Cookie 访问管理页 → 管理页面');
    r = await fetch(B + '/admin/api/state', { headers: { cookie } });
    ok(r.status === 200, '带 Cookie 调用管理接口 → 200');
    r = await fetch(B + '/admin/api/state', { headers: { 'x-admin-key': 'sk-admin-x' } });
    ok(r.status === 200, '脚本路径：x-admin-key=proxyKey 仍可用 → 200');

    r = await fetch(B + '/v1/models', { headers: { 'x-api-key': 'sk-admin-x' } });
    ok(r.status === 200, '中转端点不走密码门，凭 proxyKey 即可 → 200');
    r = await fetch(B + '/v1/models');
    ok(r.status === 401, '中转端点仍由 proxyKey 控制（不带 key → 401）');

    console.log(failures ? '\n实例 B 有失败项' : '\n实例 B（密码保护）全部通过 ✓');
  } catch (e) {
    failures++;
    console.error('实例 B 执行异常:', e);
  } finally {
    await stopRelay(relay);
  }

  console.log(failures ? '\n有 ' + failures + ' 项失败' : '\n全部通过 ✓');
  process.exit(failures ? 1 : 0);
})();
