'use strict';
// 本地 mock 上游，用于自测轮换与协议转换：
//   9101 = OpenAI 协议   key 含 dead→402余额不足 / cool→429限流 / badreq→400 / 其他→成功
//   9102 = Anthropic 协议 key 含 dead→403无效 / 其他→成功
// 请求最后一条 user 消息包含 TOOLCALL 时返回工具调用。

const http = require('http');

function readBody(req) {
  return new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); });
}
function json(res, status, obj) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

const openai = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url.includes('/models')) return json(res, 200, { object: 'list', data: [{ id: 'mock-model', object: 'model' }] });
    if (req.method === 'POST' && req.url.includes('/responses')) { // Responses API：原样回一个最小响应
      await readBody(req);
      return json(res, 200, { id: 'resp_mock', object: 'response', status: 'completed', model: 'mock-model', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'mock responses ok' }] }] });
    }
    if (req.method !== 'POST' || !req.url.includes('/chat/completions')) return json(res, 404, { error: { message: 'mock-openai: 未知路径 ' + req.url } });
    const body = JSON.parse(await readBody(req));
    const key = String(req.headers['authorization'] || '').replace(/^Bearer\s*/i, '');
    if (key.includes('dead')) return json(res, 402, { code: 'INSUFFICIENT_BALANCE', message: '余额不足', traceId: 'trace_mock' });
    if (key.includes('cool')) return json(res, 429, { error: { message: 'rate limit exceeded, too many requests' } });
    if (key.includes('badreq')) return json(res, 400, { error: { message: 'invalid request: bad parameter' } });
    const lastUser = (body.messages || []).filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join(' ');
    const useTool = lastUser.includes('TOOLCALL');
    if (body.stream) {
      const id = 'chatcmpl-mock';
      const f = [];
      f.push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
      if (useTool) {
        f.push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_mock1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] })}\n\n`);
        for (const piece of ['{"city":', '"北京"}']) f.push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null }] })}\n\n`);
        f.push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      } else {
        for (const t of ['你好', '，', '世界']) f.push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] })}\n\n`);
        f.push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } })}\n\n`);
      }
      f.push('data: [DONE]\n\n');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const x of f) res.write(x);
      return res.end();
    }
    if (useTool) return json(res, 200, {
      id: 'chatcmpl-mock', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_mock1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    return json(res, 200, {
      id: 'chatcmpl-mock', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '你好，世界（来自 mock-openai，key=' + key.slice(-4) + '）' } }],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    });
  } catch (e) { json(res, 500, { error: { message: e.message } }); }
});

const anthropic = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url.includes('/models')) return json(res, 200, { data: [{ id: 'mock-claude', type: 'model' }] });
    if (req.method !== 'POST' || !req.url.includes('/messages')) return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'mock-anthropic: 未知路径 ' + req.url } });
    const body = JSON.parse(await readBody(req));
    const key = String(req.headers['x-api-key'] || '');
    if (key.includes('dead')) return json(res, 403, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    const lastUser = (body.messages || []).filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join(' ');
    const useTool = lastUser.includes('TOOLCALL');
    if (body.stream) {
      const f = [];
      f.push(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 8, output_tokens: 0 } } })}\n\n`);
      if (useTool) {
        f.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_mock1', name: 'get_weather', input: {} } })}\n\n`);
        for (const piece of ['{"city":', '"上海"}']) f.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: piece } })}\n\n`);
        f.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
        f.push(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } })}\n\n`);
      } else {
        f.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
        for (const t of ['早上好', '！']) f.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })}\n\n`);
        f.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
        f.push(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } })}\n\n`);
      }
      f.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const x of f) res.write(x);
      return res.end();
    }
    if (useTool) return json(res, 200, {
      id: 'msg_mock', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'tool_use', id: 'toolu_mock1', name: 'get_weather', input: { city: '上海' } }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 8, output_tokens: 7 },
    });
    return json(res, 200, {
      id: 'msg_mock', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: '早上好！（来自 mock-anthropic，key=' + key.slice(-4) + '）' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 8, output_tokens: 9 },
    });
  } catch (e) { json(res, 500, { type: 'error', error: { type: 'api_error', message: e.message } }); }
});

openai.listen(9101, '127.0.0.1', () => console.log('mock-openai    http://127.0.0.1:9101/v1'));
anthropic.listen(9102, '127.0.0.1', () => console.log('mock-anthropic http://127.0.0.1:9102/v1'));
