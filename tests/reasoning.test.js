'use strict';
// reasoning_content 透传回归自测：上游带推理内容（OpenAI 的 reasoning_content /
// Anthropic 的 thinking 块）时，中转的流式与非流式路径都必须完整送达客户端：
//   A. OpenAI 客户端 -> OpenAI 上游   ：同协议原样透传，reasoning_content 一字不差
//   B. OpenAI 客户端 -> Anthropic 上游：thinking -> reasoning_content
//   C. Anthropic 客户端 -> OpenAI 上游：reasoning_content -> thinking 块
// 运行：node tests/reasoning.test.js   （脚本自建 mock 上游，不碰真实 config.json）

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RELAY_PORT = 8793;
let failures = 0;
function ok(cond, name) { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failures++; }

const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); });
const json = (res, s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

const REASONING = '思考过程ABC【保持原样】';
const ANSWER = '答案123';

/* ---------- OpenAI 上游：message/delta 均带 reasoning_content ---------- */
const openaiUp = http.createServer(async (req, res) => {
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { reasoning_content: REASONING }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: ANSWER }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    json(res, 200, { id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: ANSWER, reasoning_content: REASONING } }] });
  } catch (e) { json(res, 500, { error: { message: e.message } }); }
});

/* ---------- Anthropic 上游：content 带 thinking 块 ---------- */
const anthropicUp = http.createServer(async (req, res) => {
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    const id = 'msg_x';
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: REASONING } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ANSWER } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      return res.end();
    }
    json(res, 200, { id, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'thinking', thinking: REASONING, signature: '' }, { type: 'text', text: ANSWER }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 9 } });
  } catch (e) { json(res, 500, { error: { message: e.message } }); }
});

/* ---------- 解析工具 ---------- */
function oaiSse(text) { // OpenAI SSE -> { reasoning, content }
  let reasoning = '', content = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
    try {
      const d = JSON.parse(line.slice(5)).choices[0].delta;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (d.content) content += d.content;
    } catch {}
  }
  return { reasoning, content };
}
function anthSse(text) { // Anthropic SSE -> { thinking, text }
  let thinking = '', textOut = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const ev = JSON.parse(line.slice(5));
      if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta') thinking += ev.delta.thinking;
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') textOut += ev.delta.text;
    } catch {}
  }
  return { thinking, text: textOut };
}

async function post(p, body) {
  const r = await fetch('http://127.0.0.1:' + RELAY_PORT + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}

(async () => {
  await new Promise(r => openaiUp.listen(0, '127.0.0.1', r));
  await new Promise(r => anthropicUp.listen(0, '127.0.0.1', r));
  const upOai = openaiUp.address().port, upAnt = anthropicUp.address().port;
  const plat = (id, name, baseUrl, protocol, models) => ({
    id, name, baseUrl, protocol, models, testModel: '', proxy: '',
    keys: [{ key: 'sk-ok', status: 'alive', lastError: '', lastUsed: 0, failCount: 0, cooldownUntil: 0 }],
  });
  const cfg = {
    port: RELAY_PORT, host: '127.0.0.1', proxyKey: '', proxyUrl: '', rateCooldownSec: 5,
    platforms: [
      plat('p_oai', 'oai上游', 'http://127.0.0.1:' + upOai, 'openai', ['m-oai']),
      plat('p_ant', 'anthropic上游', 'http://127.0.0.1:' + upAnt, 'anthropic', ['m-ant']),
    ],
  };
  const cfgPath = path.join(os.tmpdir(), 'llm-relay-reasoning-test-' + Date.now() + '.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const child = spawn(process.execPath, ['server.js', '--port', String(RELAY_PORT)], { cwd: ROOT, env: { ...process.env, RELAY_CONFIG: cfgPath }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', d => process.stdout.write('[relay!] ' + d));

  try {
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) { try { ready = (await fetch('http://127.0.0.1:' + RELAY_PORT + '/admin/api/state')).ok; } catch {} if (!ready) await new Promise(r => setTimeout(r, 200)); }
    if (!ready) throw new Error('中转实例未就绪');

    // A. OpenAI 客户端 -> OpenAI 上游：同协议原样透传
    let r = await post('/v1/chat/completions', { model: 'm-oai', messages: [{ role: 'user', content: 'hi' }] });
    const jA = JSON.parse(r.text);
    ok(r.status === 200 && jA.choices[0].message.reasoning_content === REASONING && jA.choices[0].message.content === ANSWER, 'A1 非流式 oai->oai：reasoning_content 原样透传');
    r = await post('/v1/chat/completions', { model: 'm-oai', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const a2 = oaiSse(r.text);
    ok(a2.reasoning === REASONING && a2.content === ANSWER, 'A2 流式 oai->oai：delta.reasoning_content 原样透传');

    // B. OpenAI 客户端 -> Anthropic 上游：thinking -> reasoning_content
    r = await post('/v1/chat/completions', { model: 'm-ant', messages: [{ role: 'user', content: 'hi' }] });
    const jB = JSON.parse(r.text);
    ok(r.status === 200 && jB.choices[0].message.reasoning_content === REASONING && jB.choices[0].message.content === ANSWER, 'B1 非流式 oai->ant：thinking 映射为 reasoning_content');
    r = await post('/v1/chat/completions', { model: 'm-ant', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const b2 = oaiSse(r.text);
    ok(b2.reasoning === REASONING && b2.content === ANSWER, 'B2 流式 oai->ant：thinking_delta 映射为 delta.reasoning_content');

    // C. Anthropic 客户端 -> OpenAI 上游：reasoning_content -> thinking 块
    r = await post('/v1/messages', { model: 'm-oai', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    const jC = JSON.parse(r.text);
    const think1 = (jC.content || []).find(b => b.type === 'thinking');
    const text1 = (jC.content || []).find(b => b.type === 'text');
    ok(r.status === 200 && think1 && think1.thinking === REASONING && text1 && text1.text === ANSWER, 'C1 非流式 ant->oai：reasoning_content 映射为 thinking 块');
    r = await post('/v1/messages', { model: 'm-oai', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const c2 = anthSse(r.text);
    ok(c2.thinking === REASONING && c2.text === ANSWER, 'C2 流式 ant->oai：thinking_delta 事件完整');

    console.log(failures ? '\n有 ' + failures + ' 项失败' : '\n全部通过 ✓');
  } catch (e) {
    failures++;
    console.error('测试执行异常:', e);
  } finally {
    child.kill();
    await new Promise(r => child.on('exit', r));
    try { fs.unlinkSync(cfgPath); } catch {}
    openaiUp.close(); anthropicUp.close();
    process.exit(failures ? 1 : 0);
  }
})();
