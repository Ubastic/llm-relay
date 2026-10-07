'use strict';
// llm-relay —— 多平台多 Key 池中转代理
// 本地端点：/v1/chat/completions(OpenAI) /v1/messages(Claude) /v1/models /v1/responses /v1/embeddings
// 管理：http://localhost:<port>/  （Web 页面，配置平台与 key，实时看每个 key 的状态）

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./convert');
const PF = require('./proxyFetch');

const ROOT = __dirname;
// RELAY_CONFIG：自定义配置文件路径（测试用），默认同目录 config.json
const CFG_PATH = process.env.RELAY_CONFIG ? path.resolve(process.env.RELAY_CONFIG) : path.join(ROOT, 'config.json');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');

const argPort = (() => { const i = process.argv.indexOf('--port'); return i >= 0 ? parseInt(process.argv[i + 1], 10) || null : null; })();
const envPort = parseInt(process.env.RELAY_PORT, 10) || null;
// RELAY_ADMIN_PASSWORD（或 ADMIN_PASSWORD）：设置后管理页需先用密码登录（Cookie 保持 30 天）；
// 不设置则和以前一样直接访问。中转端点 /v1/* 不受影响，仍由 proxyKey 控制。
const ADMIN_PASSWORD = process.env.RELAY_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '';

/* ---------------- 配置 ---------------- */
let cfg = loadConfig();
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    if (!Array.isArray(c.platforms)) c.platforms = [];
    return c;
  } catch {
    const def = { port: 8787, host: '127.0.0.1', proxyKey: '', proxyUrl: '', rateCooldownSec: 60, platforms: [] };
    try { fs.writeFileSync(CFG_PATH, JSON.stringify(def, null, 2)); } catch {}
    return def;
  }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2)); } catch (e) { console.error('[!] 配置保存失败:', e.message); }
  }, 300);
}

const stats = { ok: 0, fail: 0, startedAt: Date.now() };
const reqLog = [];
function attemptLog(model, platform, keyMask, ok, ms, msg) {
  reqLog.unshift({ t: Date.now(), model, platform, key: keyMask, ok, ms, msg: msg || '' });
  if (reqLog.length > 100) reqLog.pop();
}

/* ---------------- 错误归类 ---------------- */
const EXHAUST_RE = /INSUFFICIENT_BALANCE|insufficient_quota|insufficient balance|quota[^\n]{0,24}(exceed|exhaust|used up|finish)|exceeded your current quota|余额不足|余额(已)?(用完|用尽|耗尽|不足)|欠费|无余额|balance[^\n]{0,16}(insufficient|exhausted|depleted|not enough|used up)|no (enough )?balance|arrears|配额(已)?(用完|用尽|耗尽)/i;
const INVALID_RE = /invalid[_ ]?api[_ ]?key|invalid\s*(api[- ]?key|x-api-key|token)|incorrect api key|api key[^\n]{0,20}(invalid|not valid|expired)|(令牌|密钥|token|key)[^\n]{0,6}无效|无效[^\n]{0,4}(令牌|密钥|token|key)|unauthorized|authentication|鉴权失败|未授权/i;
// 账号级永久问题（冻结/封禁/停用）：key 已废，等同无效，换下一个 key 重试
const FROZEN_RE = /冻结|封禁|封停|已停机|(账号|帐号|账户|计费账户|令牌|密钥|token)[^\n]{0,6}(被)?(禁用|停用)|(banned|suspended|deactivated)|account[^\n]{0,16}(frozen|disabled|blocked|suspended)/i;
const RATE_RE = /rate[- ]?limit|too many requests|请求过于频繁|限流|请求速度|throttl|并发过高/i;
const NEXT_PLAT_RE = /MODEL_NOT_AVAILABLE|model[^\n]{0,30}(not found|not available|does not exist)|模型不存在|模型不可用|不支持该协议|无可用渠道|no available channel|not supported/i;

function classify(status, text) {
  let hay = String(text || '');
  let msg = hay.slice(0, 300);
  try {
    const j = JSON.parse(text);
    const parts = [j.error && j.error.message, j.error && j.error.code, j.error && j.error.type, j.message, j.code, j.type];
    hay = parts.filter(Boolean).map(String).join(' | ') + ' | ' + hay;
    msg = String((j.error && j.error.message) || j.message || msg).slice(0, 300);
  } catch {}
  if (EXHAUST_RE.test(hay) || status === 402) return { type: 'exhausted', msg };
  if (FROZEN_RE.test(hay)) return { type: 'invalid', msg };
  if (status === 401 || status === 403 || INVALID_RE.test(hay)) return { type: 'invalid', msg };
  if (status === 429 || RATE_RE.test(hay)) return { type: 'rate', msg };
  if (status >= 500 || status === 408 || !status) return { type: 'transient', msg };
  if (status >= 400) {
    if (NEXT_PLAT_RE.test(hay)) return { type: 'next_platform', msg };
    return { type: 'bad_request', msg, status };
  }
  return { type: 'transient', msg };
}

/* ---------------- key 池 ---------------- */
function mask(k) { k = String(k || ''); return k.length <= 12 ? k.slice(0, 4) + '…' + k.slice(-2) : k.slice(0, 8) + '…' + k.slice(-4); }
function keyStatus(k) {
  if (k.status === 'disabled') return 'disabled';
  if (k.status === 'exhausted') return 'exhausted';
  if (k.status === 'invalid') return 'invalid';
  if ((k.cooldownUntil || 0) > Date.now()) return 'cooldown';
  return 'alive';
}
function aliveKeys(p) { return (p.keys || []).filter(k => k.status === 'alive' && (k.cooldownUntil || 0) <= Date.now()); }
function markKey(p, k, type, msg) {
  if (type === 'ok') { k.status = 'alive'; k.lastUsed = Date.now(); k.lastError = ''; k.failCount = 0; k.cooldownUntil = 0; }
  else if (type === 'exhausted') { k.status = 'exhausted'; k.lastError = '[无余额] ' + msg; }
  else if (type === 'invalid') { k.status = 'invalid'; k.lastError = '[无效] ' + msg; }
  else if (type === 'rate') { k.cooldownUntil = Date.now() + (cfg.rateCooldownSec || 60) * 1000; k.lastError = '[限流] ' + msg; }
  else if (type === 'transient') {
    k.failCount = (k.failCount || 0) + 1; k.lastError = msg;
    if (k.failCount >= 3) { k.cooldownUntil = Date.now() + 120000; k.lastError = '[连续失败' + 3 + '次，冷却2分钟] ' + msg; k.failCount = 0; }
  } else return; // next_platform 等不动 key 状态
  save();
}

/* ---------------- 工具 ---------------- */
function joinBase(base, sub) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(b)) b = 'http://' + b;
  if (/\/v\d+([a-z]*)?$/i.test(b)) return b + sub;
  return b + '/v1' + sub;
}
function sendJson(res, status, obj) {
  if (res.headersSent) { try { res.end(); } catch {} return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function fmtError(incoming, status, msg, type) {
  if (incoming === 'anthropic') return { type: 'error', error: { type: type || 'api_error', message: msg } };
  return { error: { message: msg, type: type || 'api_error', code: null } };
}
function sendUpstreamError(res, incoming, status, text) {
  let msg = String(text || '上游错误').slice(0, 600), type;
  try { const j = JSON.parse(text); msg = String((j.error && j.error.message) || j.message || msg).slice(0, 600); type = (j.error && j.error.type) || j.code; } catch {}
  sendJson(res, status || 400, fmtError(incoming, status || 400, msg, type));
}
function readBody(req, cap) {
  cap = cap || 200 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > cap) { reject(new Error('请求体过大')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function estimateTokens(s) {
  s = String(s || '');
  const cjk = (s.match(/[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/g) || []).length;
  return Math.max(1, Math.round(cjk + (s.length - cjk) / 4));
}
function safeParse(s) { try { return JSON.parse(s); } catch { return { raw: s }; } }
function sseHeaders() {
  return { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'x-accel-buffering': 'no' };
}
function checkAuth(req) {
  if (!cfg.proxyKey) return true;
  const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const xk = String(req.headers['x-api-key'] || '').trim();
  return bearer === cfg.proxyKey || xk === cfg.proxyKey;
}

/* ---------------- 管理页密码保护 ---------------- */
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
// 登录凭证：过期时间戳 + 以密码为密钥的 HMAC，不存会话、重启后仍有效
function authSign(exp) { return crypto.createHmac('sha256', ADMIN_PASSWORD).update('relay-auth-' + exp).digest('hex'); }
function makeAuthToken() { const exp = Date.now() + 30 * 86400000; return exp + '.' + authSign(exp); }
function checkAuthToken(t) {
  const i = String(t || '').indexOf('.');
  if (i <= 0) return false;
  const exp = t.slice(0, i), sig = t.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expect = authSign(exp);
  return sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
}
// 管理接口鉴权：开了密码门则有效登录 Cookie 直接放行；否则沿用 proxyKey（两者兼容，脚本仍可用 x-admin-key）
function adminAuthed(req) {
  if (ADMIN_PASSWORD && checkAuthToken(parseCookies(req).relay_auth)) return true;
  return !cfg.proxyKey || String(req.headers['x-admin-key'] || '') === cfg.proxyKey;
}

/* ---------------- 出站代理 ---------------- */
// 优先级：平台代理 > 全局 proxyUrl > 环境变量（RELAY_PROXY / HTTPS_PROXY）
// 平台填 direct 表示强制直连（即使配置了全局代理）
function pickProxy(p) {
  const own = String((p && p.proxy) || '').trim();
  if (/^(direct|none|off|-)$/i.test(own)) return null;
  let url = own || String(cfg.proxyUrl || '').trim()
    || process.env.RELAY_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '';
  url = String(url).trim();
  if (!url || /^(direct|none|off|-)$/i.test(url)) return null; // direct 也可用于全局
  return url;
}

// fetch 的代理感知包装：没有代理配置时行为与全局 fetch 完全一致
function uFetch(url, opts, platform) {
  const px = pickProxy(platform);
  if (!px) return fetch(url, opts);
  return PF.proxyFetch(url, opts, px);
}

/* ---------------- SSE 嗅探与管道 ---------------- */
// 读到首个 data: 事件为止：可据此发现「HTTP 200 但内容是错误」的中转站行为，还没向客户端写任何字节时可以换 key 重试
async function sniffSSE(resp) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let first; // undefined=还没找到, null=流已结束
  while (true) {
    const { done, value } = await reader.read();
    if (done) { first = null; break; }
    buf += dec.decode(value, { stream: true });
    let from = 0;
    while (true) {
      const nl = buf.indexOf('\n', from);
      if (nl === -1) break;
      const line = buf.slice(from, nl).replace(/\r$/, '');
      from = nl + 1;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      first = payload === '[DONE]' ? { done: true } : safeParse(payload);
      break;
    }
    if (first !== undefined) break;
  }
  let error = null, errorRaw = null;
  if (first && typeof first === 'object' && (first.error || first.type === 'error')) {
    errorRaw = JSON.stringify(first);
    error = classify(200, errorRaw);
  }
  return { reader, consumed: buf, error, errorRaw };
}

async function pipeRaw(reader, res, consumed) {
  if (consumed) res.write(consumed);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (e) { if (e.name !== 'AbortError') console.error('[!] 上游流中断:', e.message); }
  res.end();
}

// 跨协议流转换：把上游 SSE 逐事件喂给转换器，写出目标协议的 SSE
async function pipeConvertSSE(reader, res, consumed, onEvent, onEnd) {
  const dec = new TextDecoder();
  let buf = '';
  const emit = (evText) => {
    const dataLines = [];
    for (const line of evText.split('\n')) if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    if (!dataLines.length) return;
    const payload = dataLines.join('\n');
    let w = '';
    try { w = onEvent(payload) || ''; } catch (e) { console.error('[!] 流转换异常:', e.message); }
    if (w) res.write(w);
  };
  const feed = (text) => {
    buf += String(text).replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const ev = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      emit(ev);
    }
  };
  try {
    feed(consumed || '');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(dec.decode(value, { stream: true }));
    }
    feed('\n\n'); // 冲刷最后一条不完整事件
  } catch (e) { if (e.name !== 'AbortError') console.error('[!] 上游流中断:', e.message); }
  let endStr = '';
  try { endStr = onEnd() || ''; } catch {}
  if (endStr) res.write(endStr);
  res.end();
}

/* ---------------- 中转核心 ---------------- */
let modelsCache = { at: 0, data: null };

async function handleRelay(req, res, sub) {
  const incoming = sub.startsWith('/messages') ? 'anthropic' : 'openai';
  const isCount = sub === '/messages/count_tokens';
  const passthroughOnly = sub === '/responses' || sub === '/embeddings' || sub === '/completions';
  const raw = (await readBody(req)).toString('utf8');

  if (!checkAuth(req)) return sendJson(res, 401, fmtError(incoming, 401, '访问密钥不正确：客户端请填入本服务设置的 proxyKey', 'authentication_error'));

  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, fmtError(incoming, 400, '请求体不是合法 JSON', 'invalid_request_error')); }
  const model = body.model || '';
  const stream = !!body.stream;

  // 路由：显式声明了该模型的平台优先，之后是未限定模型的兜底平台，按配置顺序
  const match = cfg.platforms.filter(p => (p.models || []).includes(model));
  const fallback = cfg.platforms.filter(p => !(p.models || []).length);
  let plan = [...match, ...fallback];
  if (passthroughOnly) plan = plan.filter(p => (p.protocol || 'openai') === 'openai');

  const tried = [];
  let attempts = 0, sawRate = false;
  const MAX_ATTEMPTS = 10;

  for (const p of plan) {
    const proto = p.protocol === 'anthropic' ? 'anthropic' : 'openai';
    if (isCount && proto !== 'anthropic') continue; // count_tokens 只转发 anthropic 上游，其余走兜底估算
    if (passthroughOnly && proto !== 'openai') continue;

    for (const k of aliveKeys(p)) {
      if (attempts >= MAX_ATTEMPTS) break;
      attempts++;
      const t0 = Date.now();
      const km = mask(k.key);

      let url, headers, bodyStr;
      if (proto === 'anthropic') {
        url = joinBase(p.baseUrl, isCount ? '/messages/count_tokens' : '/messages');
        headers = { 'content-type': 'application/json', 'x-api-key': k.key, 'anthropic-version': req.headers['anthropic-version'] || '2023-06-01' };
        if (req.headers['anthropic-beta']) headers['anthropic-beta'] = String(req.headers['anthropic-beta']);
        bodyStr = incoming === 'anthropic' ? raw : JSON.stringify(C.openaiReqToAnthropic(body));
      } else {
        // OpenAI 上游：anthropic 入站（协议转换）固定走 /chat/completions；openai 入站（透传）跟随原始路径
        url = joinBase(p.baseUrl, incoming === 'anthropic' ? '/chat/completions' : sub);
        headers = { 'content-type': 'application/json', 'authorization': 'Bearer ' + k.key };
        bodyStr = incoming === 'openai' ? raw : JSON.stringify(C.anthropicReqToOpenai(body));
      }

      const ac = new AbortController();
      const onClose = () => ac.abort();
      req.on('close', onClose);

      let resp;
      try {
        resp = await uFetch(url, { method: 'POST', headers, body: bodyStr, signal: ac.signal }, p);
      } catch (e) {
        req.off('close', onClose);
        if (e.name === 'AbortError') return; // 客户端断开
        markKey(p, k, 'transient', '网络错误: ' + e.message);
        tried.push(p.name + '[' + km + '] 网络错误: ' + e.message);
        attemptLog(model, p.name, km, false, Date.now() - t0, '网络错误');
        continue;
      }

      // 上游明确报错（非 200）：归类、换下一个 key，400 类直接透传给客户端
      if (!resp.ok) {
        const txt = await resp.text();
        req.off('close', onClose);
        const cls = classify(resp.status, txt);
        markKey(p, k, cls.type, cls.msg);
        tried.push(p.name + '[' + km + '] ' + cls.type + ': ' + cls.msg);
        attemptLog(model, p.name, km, false, Date.now() - t0, cls.type);
        if (cls.type === 'bad_request') return sendUpstreamError(res, incoming, resp.status, txt);
        if (cls.type === 'next_platform') break;
        if (cls.type === 'rate') sawRate = true;
        continue;
      }

      try {
        // ---- count_tokens（anthropic 上游转发）----
        if (isCount) {
          if (!resp.ok && (resp.status === 404 || resp.status === 400 || resp.status === 405)) {
            req.off('close', onClose);
            return sendJson(res, 200, { input_tokens: estimateTokens(bodyStr) }); // 上游不支持该接口时本地估算
          }
          const txt = await resp.text();
          req.off('close', onClose);
          markKey(p, k, 'ok', '');
          let j = {}; try { j = JSON.parse(txt); } catch {}
          attemptLog(model, p.name, km, true, Date.now() - t0, 'count_tokens');
          return sendJson(res, 200, { input_tokens: j.input_tokens ?? estimateTokens(bodyStr) });
        }

        // ---- 流式 ----
        if (stream || /text\/event-stream/i.test(resp.headers.get('content-type') || '')) {
          const sn = await sniffSSE(resp);
          req.off('close', onClose);
          if (sn.error) { // 200 但首个事件就是错误 -> 换 key 重试
            markKey(p, k, sn.error.type, sn.error.msg);
            tried.push(p.name + '[' + km + '] ' + sn.error.type + ': ' + sn.error.msg);
            attemptLog(model, p.name, km, false, Date.now() - t0, sn.error.type);
            if (sn.error.type === 'bad_request') return sendUpstreamError(res, incoming, resp.status, sn.errorRaw);
            if (sn.error.type === 'next_platform') break;
            if (sn.error.type === 'rate') sawRate = true;
            continue;
          }
          res.writeHead(200, sseHeaders());
          if (proto === incoming) {
            await pipeRaw(sn.reader, res, sn.consumed); // 同协议：原样透传
          } else if (proto === 'anthropic') {
            const cv = new C.AnthToOaiStream(model);
            await pipeConvertSSE(sn.reader, res, sn.consumed, payload => {
              if (payload === '[DONE]') return '';
              const ev = safeParse(payload);
              return ev.raw ? '' : cv.push(ev).join('');
            }, () => cv.end());
          } else {
            const cv = new C.OaiToAnthStream(model);
            await pipeConvertSSE(sn.reader, res, sn.consumed, payload => {
              if (payload === '[DONE]') return '';
              const ch = safeParse(payload);
              return ch.raw ? '' : cv.push(ch).join('');
            }, () => cv.end());
          }
          markKey(p, k, 'ok', '');
          attemptLog(model, p.name, km, true, Date.now() - t0, stream ? 'stream' : 'stream(auto)');
          stats.ok++;
          return;
        }

        // ---- 非流式 ----
        const txt = await resp.text();
        req.off('close', onClose);
        let j = null; try { j = JSON.parse(txt); } catch {}
        if (j && (j.error || j.type === 'error')) { // 200 但 body 是错误
          const cls = classify(200, txt);
          markKey(p, k, cls.type, cls.msg);
          tried.push(p.name + '[' + km + '] ' + cls.type + ': ' + cls.msg);
          attemptLog(model, p.name, km, false, Date.now() - t0, cls.type);
          if (cls.type === 'next_platform') break;
          if (cls.type === 'rate') sawRate = true;
          continue;
        }
        markKey(p, k, 'ok', '');
        let outText = txt;
        if (proto !== incoming) outText = JSON.stringify(proto === 'anthropic' ? C.anthropicRespToOpenai(j) : C.openaiRespToAnthropic(j));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(outText);
        attemptLog(model, p.name, km, true, Date.now() - t0, '');
        stats.ok++;
        return;
      } catch (e) {
        req.off('close', onClose);
        if (e.name === 'AbortError') { try { res.end(); } catch {} return; }
        if (res.headersSent) { console.error('[!] 响应已开始后出错:', e.message); try { res.end(); } catch {} return; }
        markKey(p, k, 'transient', '读取失败: ' + e.message);
        tried.push(p.name + '[' + km + '] 读取失败: ' + e.message);
        attemptLog(model, p.name, km, false, Date.now() - t0, '读取失败');
        continue;
      }
    }
  }

  // 全部尝试失败
  if (isCount) return sendJson(res, 200, { input_tokens: estimateTokens(raw) });
  stats.fail++;
  const msg = tried.length
    ? '所有 key 均尝试失败（共 ' + attempts + ' 次）：\n' + tried.join('\n')
    : '没有可用的平台/key 能处理模型「' + (model || '(未指定)') + '」，请到管理页检查配置';
  const status = sawRate ? 429 : 502;
  attemptLog(model, '-', '-', false, 0, sawRate ? '全部失败(限流)' : '全部失败');
  sendJson(res, status, fmtError(incoming, status, msg, sawRate ? 'rate_limit_error' : 'api_error'));
}

/* ---------------- /v1/models 聚合 ---------------- */
async function handleModels(req, res) {
  if (!checkAuth(req)) return sendJson(res, 401, { error: { message: '访问密钥不正确', type: 'authentication_error' } });
  if (modelsCache.data && Date.now() - modelsCache.at < 60000) return sendJson(res, 200, modelsCache.data);
  const out = new Map();
  await Promise.all(cfg.platforms.map(async p => {
    const proto = p.protocol === 'anthropic' ? 'anthropic' : 'openai';
    for (const k of aliveKeys(p).slice(0, 3)) {
      try {
        const headers = proto === 'anthropic'
          ? { 'x-api-key': k.key, 'anthropic-version': '2023-06-01' }
          : { 'authorization': 'Bearer ' + k.key };
        const r = await uFetch(joinBase(p.baseUrl, '/models'), { headers, signal: AbortSignal.timeout(15000) }, p);
        if (!r.ok) continue;
        const j = await r.json();
        for (const m of (j.data || j.models || [])) if (m && m.id) out.set(String(m.id), { id: String(m.id), object: 'model', owned_by: p.name });
        break;
      } catch {}
    }
    for (const m of p.models || []) if (!out.has(m)) out.set(m, { id: m, object: 'model', owned_by: p.name });
  }));
  const data = { object: 'list', data: [...out.values()] };
  modelsCache = { at: Date.now(), data };
  sendJson(res, 200, data);
}

/* ---------------- 管理接口 ---------------- */
function stateView() {
  return {
    port: PORT,
    proxyKey: cfg.proxyKey,
    proxyUrl: cfg.proxyUrl || '',
    rateCooldownSec: cfg.rateCooldownSec,
    platforms: cfg.platforms.map(p => ({
      id: p.id, name: p.name, baseUrl: p.baseUrl, protocol: p.protocol || 'openai',
      models: p.models || [], testModel: p.testModel || '', proxy: p.proxy || '',
      keys: (p.keys || []).map((k, i) => ({ i, mask: mask(k.key), status: keyStatus(k), lastError: k.lastError || '', lastUsed: k.lastUsed || 0, cooldownUntil: k.cooldownUntil || 0, failCount: k.failCount || 0 })),
    })),
    stats: { ok: stats.ok, fail: stats.fail, startedAt: stats.startedAt },
    log: reqLog,
  };
}

function newKey(kk) { return { key: kk, status: 'alive', lastError: '', lastUsed: 0, failCount: 0, cooldownUntil: 0 }; }

// 导入配置时的 key 归一化：字符串或完整对象都接受，非法状态回落 alive
function normKey(raw) {
  if (typeof raw === 'string') return raw.trim() ? newKey(raw.trim()) : null;
  if (!raw || typeof raw.key !== 'string' || !raw.key.trim()) return null;
  const st = ['alive', 'disabled', 'exhausted', 'invalid'].includes(raw.status) ? raw.status : 'alive';
  return { key: raw.key.trim(), status: st, lastError: String(raw.lastError || ''), lastUsed: Number(raw.lastUsed) || 0, failCount: Number(raw.failCount) || 0, cooldownUntil: Number(raw.cooldownUntil) || 0 };
}

async function testKey(p, k) {
  const proto = p.protocol === 'anthropic' ? 'anthropic' : 'openai';
  const model = p.testModel || (p.models || [])[0] || 'glm-5.3-flash';
  const t0 = Date.now();
  let url, headers, bodyStr;
  if (proto === 'anthropic') {
    url = joinBase(p.baseUrl, '/messages');
    headers = { 'content-type': 'application/json', 'x-api-key': k.key, 'anthropic-version': '2023-06-01' };
    bodyStr = JSON.stringify({ model, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] });
  } else {
    url = joinBase(p.baseUrl, '/chat/completions');
    headers = { 'content-type': 'application/json', 'authorization': 'Bearer ' + k.key };
    bodyStr = JSON.stringify({ model, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] });
  }
  try {
    const r = await uFetch(url, { method: 'POST', headers, body: bodyStr, signal: AbortSignal.timeout(30000) }, p);
    const txt = await r.text();
    if (r.ok) { markKey(p, k, 'ok', ''); return { ok: true, status: r.status, ms: Date.now() - t0, msg: '测试通过（' + model + '）' }; }
    const cls = classify(r.status, txt);
    if (cls.type === 'exhausted' || cls.type === 'invalid') markKey(p, k, cls.type, cls.msg);
    return { ok: false, status: r.status, ms: Date.now() - t0, msg: cls.type + ': ' + cls.msg };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, msg: '网络错误: ' + e.message };
  }
}

async function handleAdmin(req, res, sub) {
  const body = await readBody(req).then(b => { try { return JSON.parse(b.toString('utf8') || '{}'); } catch { return {}; } }).catch(() => ({}));

  // 登录：无需已有凭证；密码错误延迟返回，拖慢爆破
  if (req.method === 'POST' && sub === '/login') {
    if (!ADMIN_PASSWORD) return sendJson(res, 400, { error: '未开启密码保护（设置环境变量 RELAY_ADMIN_PASSWORD）' });
    const pw = String(body.password || '');
    const same = pw.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD));
    if (!same) {
      await new Promise(r => setTimeout(r, 800));
      return sendJson(res, 401, { error: '密码错误' });
    }
    res.setHeader('set-cookie', 'relay_auth=' + makeAuthToken() + '; Path=/; HttpOnly; Max-Age=' + 30 * 86400 + '; SameSite=Strict');
    return sendJson(res, 200, { ok: true });
  }

  if (!adminAuthed(req)) return sendJson(res, 401, { error: ADMIN_PASSWORD ? '需要登录或访问密钥（proxyKey）' : '需要访问密钥（proxyKey）' });

  if (req.method === 'GET' && sub === '/state') return sendJson(res, 200, stateView());

  if (req.method === 'GET' && sub === '/config/export') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="llm-relay-config.json"',
    });
    return res.end(JSON.stringify(cfg, null, 2));
  }

  if (req.method === 'POST' && sub === '/config/import') {
    const c = body && typeof body === 'object' ? (body.config && typeof body.config === 'object' ? body.config : body) : null;
    if (!c || !Array.isArray(c.platforms)) return sendJson(res, 400, { error: '配置格式不对：缺少 platforms 数组' });
    const plats = [], seen = new Set();
    for (const raw of c.platforms) {
      if (!raw || !String(raw.name || '').trim() || !String(raw.baseUrl || '').trim())
        return sendJson(res, 400, { error: '存在缺少名称或 Base URL 的平台，导入已取消' });
      let id = String(raw.id || '').trim();
      if (!id || seen.has(id)) id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      seen.add(id);
      const keys = (Array.isArray(raw.keys) ? raw.keys : []).map(normKey).filter(Boolean);
      plats.push({
        id, name: String(raw.name).trim(), baseUrl: String(raw.baseUrl).trim(),
        protocol: raw.protocol === 'anthropic' ? 'anthropic' : 'openai',
        models: Array.isArray(raw.models) ? raw.models.map(String).filter(Boolean) : [],
        testModel: String(raw.testModel || '').trim(), proxy: String(raw.proxy || '').trim(), keys,
      });
    }
    if (typeof c.proxyKey === 'string') cfg.proxyKey = c.proxyKey.trim();
    if (typeof c.proxyUrl === 'string') cfg.proxyUrl = c.proxyUrl.trim();
    if (Number.isFinite(c.rateCooldownSec)) cfg.rateCooldownSec = Math.max(5, c.rateCooldownSec);
    cfg.platforms = plats;
    save(); modelsCache = { at: 0, data: null };
    return sendJson(res, 200, { ok: true, platforms: plats.length, keys: plats.reduce((n, p) => n + p.keys.length, 0) });
  }

  if (req.method === 'GET' && sub === '/platform') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const p = cfg.platforms.find(x => x.id === id);
    if (!p) return sendJson(res, 404, { error: '平台不存在' });
    return sendJson(res, 200, p);
  }

  if (req.method === 'POST' && sub === '/platform/save') {
    const { id, name, baseUrl, protocol, modelsText, testModel, keysText } = body;
    if (!name || !baseUrl) return sendJson(res, 400, { error: '名称和 Base URL 必填' });
    const proto = protocol === 'anthropic' ? 'anthropic' : 'openai';
    const models = String(modelsText || '').split(/[\n,，]+/).map(s => s.trim()).filter(Boolean);
    const keyList = [...new Set(String(keysText || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
    const proxy = String(body.proxy || '').trim();
    if (proxy && !/^(direct|none|off|-)$/i.test(proxy)) {
      try { PF.parseProxy(proxy); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    let p;
    if (id) {
      p = cfg.platforms.find(x => x.id === id);
      if (!p) return sendJson(res, 404, { error: '平台不存在' });
      Object.assign(p, { name: String(name).trim(), baseUrl: String(baseUrl).trim(), protocol: proto, models, testModel: String(testModel || '').trim(), proxy });
      const old = new Map((p.keys || []).map(k => [k.key, k]));
      p.keys = keyList.map(kk => old.get(kk) || newKey(kk));
    } else {
      p = {
        id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: String(name).trim(), baseUrl: String(baseUrl).trim(), protocol: proto,
        models, testModel: String(testModel || '').trim(), proxy, keys: keyList.map(newKey),
      };
      cfg.platforms.push(p);
    }
    save(); modelsCache = { at: 0, data: null };
    return sendJson(res, 200, { ok: true, id: p.id, keys: p.keys.length });
  }

  if (req.method === 'POST' && sub === '/platform/delete') {
    cfg.platforms = cfg.platforms.filter(x => x.id !== body.id);
    save(); modelsCache = { at: 0, data: null };
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && sub === '/platform/reset-failed') {
    const p = cfg.platforms.find(x => x.id === body.id);
    if (p) for (const k of p.keys || []) {
      if (k.status === 'exhausted' || k.status === 'invalid') { k.status = 'alive'; k.lastError = ''; k.failCount = 0; k.cooldownUntil = 0; }
    }
    save();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && sub === '/key/op') {
    const p = cfg.platforms.find(x => x.id === body.pid);
    const k = p && (p.keys || [])[body.i];
    if (!k) return sendJson(res, 404, { error: 'key 不存在' });
    if (body.op === 'enable') { k.status = 'alive'; k.lastError = ''; k.failCount = 0; k.cooldownUntil = 0; save(); return sendJson(res, 200, { ok: true }); }
    if (body.op === 'disable') { k.status = 'disabled'; save(); return sendJson(res, 200, { ok: true }); }
    if (body.op === 'test') return sendJson(res, 200, await testKey(p, k));
    return sendJson(res, 400, { error: '未知操作' });
  }

  if (req.method === 'POST' && sub === '/settings') {
    if (typeof body.proxyKey === 'string') cfg.proxyKey = body.proxyKey.trim();
    if (typeof body.proxyUrl === 'string') {
      const v = body.proxyUrl.trim();
      try { if (v && !/^(direct|none|off|-)$/i.test(v)) PF.parseProxy(v); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      cfg.proxyUrl = v;
    }
    if (Number.isFinite(body.rateCooldownSec)) cfg.rateCooldownSec = Math.max(5, body.rateCooldownSec);
    save();
    return sendJson(res, 200, { ok: true, note: 'proxyKey / 代理即时生效；修改端口请编辑 config.json 后重启' });
  }

  sendJson(res, 404, { error: '未知管理接口 ' + sub });
}

/* ---------------- HTTP 服务 ---------------- */
const PORT = argPort || envPort || cfg.port || 8787;
const HOST = cfg.host || '127.0.0.1';

const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 - LLM Key 中转池</title>
<style>
  :root { --bg:#0e1116; --card:#161b23; --line:#263041; --txt:#dbe4f0; --dim:#8494ab; --acc:#4f8cff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; }
  .box { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:34px 38px; width:320px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:var(--dim); font-size:13px; margin:0 0 18px; }
  input { width:100%; background:#0a0d12; color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:9px 11px; font-size:14px; }
  input:focus { outline:none; border-color:var(--acc); }
  button { width:100%; margin-top:12px; background:var(--acc); border:1px solid var(--acc); color:#fff; border-radius:8px; padding:9px; cursor:pointer; font-size:14px; }
  #msg { color:#ef7b7b; font-size:13px; min-height:20px; margin-top:10px; }
</style>
</head>
<body>
<div class="box">
  <h1>🔑 LLM Key 中转池</h1>
  <p class="sub">本管理页已开启密码保护，请输入访问密码</p>
  <input type="password" id="pw" placeholder="访问密码" autofocus>
  <button id="go">登 录</button>
  <div id="msg"></div>
</div>
<script>
async function go() {
  const msg = document.querySelector('#msg');
  msg.textContent = '';
  try {
    const r = await fetch('/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: document.querySelector('#pw').value }) });
    if (r.ok) { location.href = '/'; return; }
    const j = await r.json().catch(() => ({}));
    msg.textContent = j.error || '密码错误';
  } catch (e) { msg.textContent = '网络错误：' + e.message; }
}
document.querySelector('#go').onclick = go;
document.querySelector('#pw').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
</script>
</body>
</html>`;

function serveIndex(req, res) {
  if (ADMIN_PASSWORD && !checkAuthToken(parseCookies(req).relay_auth)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(LOGIN_HTML);
  }
  fs.readFile(INDEX_PATH, (e, buf) => {
    if (e) { res.writeHead(500); return res.end('public/index.html 缺失'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  res.on('error', () => {});
  req.on('error', () => {});
  try {
    const u = new URL(req.url, 'http://x');
    const p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '/index.html') return serveIndex(req, res);
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p.startsWith('/admin/api/')) return await handleAdmin(req, res, p.slice('/admin/api'.length));

    // 中转路径：容忍 /v1 前缀重复或缺失（/v1/v1/messages、/messages 都归一到 /messages）
    let sub = p;
    while (true) { const m = /^\/v1(?=\/|$)/.exec(sub); if (!m) break; sub = sub.slice(3); }
    if (sub === '/models' && req.method === 'GET') return await handleModels(req, res);
    const relayPaths = ['/chat/completions', '/completions', '/responses', '/embeddings', '/messages', '/messages/count_tokens'];
    if (req.method === 'POST' && relayPaths.includes(sub)) return await handleRelay(req, res, sub);

    sendJson(res, 404, { error: { message: '未知路径 ' + p + '。可用端点: /v1/chat/completions, /v1/messages, /v1/models, /v1/responses, /v1/embeddings, /v1/messages/count_tokens', type: 'not_found' } });
  } catch (e) {
    console.error('[!] 处理请求出错:', e);
    sendJson(res, 500, { error: { message: '中转内部错误: ' + e.message, type: 'api_error' } });
  }
});

server.listen(PORT, HOST, () => {
  const nk = cfg.platforms.reduce((n, p) => n + (p.keys || []).length, 0);
  const px = String(cfg.proxyUrl || '').trim();
  console.log('');
  console.log('  LLM Key 中转池 已启动');
  console.log('  管理页       http://localhost:' + PORT + '/');
  console.log('  OpenAI 端点  http://localhost:' + PORT + '/v1   （base_url 填这个）');
  console.log('  Claude 端点  http://localhost:' + PORT + '       （ANTHROPIC_BASE_URL 填这个）');
  console.log('  当前 ' + cfg.platforms.length + ' 个平台 / ' + nk + ' 个 key' + (px ? ' / 全局出站代理 ' + px : ''));
  console.log('');
});
server.on('error', e => { console.error('[!] 服务启动失败:', e.message); process.exit(1); });
process.on('SIGINT', () => { try { fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2)); } catch {} process.exit(0); });
