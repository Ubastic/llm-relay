'use strict';
// llm-relay —— 多平台多 Key 池中转代理
// 本地端点：/v1/chat/completions(OpenAI) /v1/messages(Claude) /v1/models /v1/responses /v1/embeddings
// 管理：http://localhost:<port>/  （Web 页面，配置平台与 key，实时看每个 key 的状态）

const http = require('http');
const fs = require('fs');
const path = require('path');
const C = require('./convert');
const PF = require('./proxyFetch');

const ROOT = __dirname;
// RELAY_CONFIG：自定义配置文件路径（测试用），默认同目录 config.json
const CFG_PATH = process.env.RELAY_CONFIG ? path.resolve(process.env.RELAY_CONFIG) : path.join(ROOT, 'config.json');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');

const argPort = (() => { const i = process.argv.indexOf('--port'); return i >= 0 ? parseInt(process.argv[i + 1], 10) || null : null; })();
const envPort = parseInt(process.env.RELAY_PORT, 10) || null;

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
  if (cfg.proxyKey && String(req.headers['x-admin-key'] || '') !== cfg.proxyKey) return sendJson(res, 401, { error: '需要访问密钥（proxyKey）' });
  const body = await readBody(req).then(b => { try { return JSON.parse(b.toString('utf8') || '{}'); } catch { return {}; } }).catch(() => ({}));

  if (req.method === 'GET' && sub === '/state') return sendJson(res, 200, stateView());

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

function serveIndex(res) {
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
    if (p === '/' || p === '/index.html') return serveIndex(res);
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
