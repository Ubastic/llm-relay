'use strict';
// OpenAI <-> Anthropic 协议转换：请求体、响应体(JSON)、流式(SSE)

function genId(p) { return p + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6); }

function openaiContentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b && b.type === 'text').map(b => b.text || '').join('');
  return '';
}

/* ================= Anthropic 请求 -> OpenAI 请求（本地 /v1/messages 转发到 OpenAI 上游） ================= */
function anthropicReqToOpenai(body) {
  const msgs = [];
  let sys = body.system;
  if (Array.isArray(sys)) sys = sys.map(b => b.text || '').join('\n');
  if (sys) msgs.push({ role: 'system', content: String(sys) });

  for (const m of body.messages || []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []);
    const before = msgs.length;
    if (m.role === 'assistant') {
      let txt = '';
      const toolCalls = [];
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === 'text') txt += (txt ? '\n' : '') + (b.text || '');
        else if (b.type === 'tool_use') toolCalls.push({ id: b.id || genId('call_'), type: 'function', function: { name: b.name || '', arguments: JSON.stringify(b.input ?? {}) } });
        // thinking 块丢弃：OpenAI 上游没有对应字段
      }
      const out = { role: 'assistant', content: txt || null };
      if (toolCalls.length) out.tool_calls = toolCalls;
      msgs.push(out);
    } else { // user
      let buf = '';
      const flush = () => { if (buf) { msgs.push({ role: 'user', content: buf }); buf = ''; } };
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === 'text') buf += b.text || '';
        else if (b.type === 'tool_result') {
          flush();
          let c = b.content;
          if (Array.isArray(c)) c = c.map(x => (x && x.type === 'text' ? x.text : '')).join('');
          if (typeof c !== 'string') c = JSON.stringify(c ?? '');
          msgs.push({ role: 'tool', tool_call_id: b.tool_use_id || '', content: c });
        } else if (b.type === 'image') buf += '[图片]';
      }
      flush();
    }
    if (msgs.length === before) msgs.push({ role: m.role || 'user', content: '' }); // 防止消息被清空后丢失轮次
  }

  const out = { model: body.model, messages: msgs, max_tokens: body.max_tokens ?? 8192 };
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
  }
  const tc = body.tool_choice;
  if (tc && typeof tc === 'object') {
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  if (body.stream) out.stream = true;
  return out;
}

/* ================= Anthropic 响应(JSON) -> OpenAI 响应(JSON) ================= */
function anthropicRespToOpenai(msg) {
  let txt = '', reasoning = '';
  const toolCalls = [];
  for (const b of msg.content || []) {
    if (!b) continue;
    if (b.type === 'text') txt += b.text || '';
    else if (b.type === 'thinking') reasoning += b.thinking || '';
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id || genId('call_'), type: 'function', function: { name: b.name || '', arguments: JSON.stringify(b.input ?? {}) } });
  }
  const message = { role: 'assistant', content: txt || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const sr = msg.stop_reason;
  const finish = sr === 'tool_use' ? 'tool_calls' : sr === 'max_tokens' ? 'length' : 'stop';
  const u = msg.usage || {};
  const usage = { prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0, total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) };
  if (u.cache_read_input_tokens != null) usage.prompt_tokens_details = { cached_tokens: u.cache_read_input_tokens };
  return {
    id: msg.id || genId('chatcmpl-'), object: 'chat.completion', created: Math.floor(Date.now() / 1000),
    model: msg.model || '', choices: [{ index: 0, message, finish_reason: finish }], usage,
  };
}

/* ================= OpenAI 请求 -> Anthropic 请求（本地 /v1/chat/completions 转发到 Anthropic 上游） ================= */
function openaiReqToAnthropic(body) {
  const systemParts = [];
  const msgs = [];
  for (const m of body.messages || []) {
    if (!m) continue;
    if (m.role === 'system' || m.role === 'developer') { systemParts.push(openaiContentText(m.content)); continue; }
    if (m.role === 'tool') {
      let c = m.content;
      if (typeof c !== 'string') c = JSON.stringify(c ?? '');
      const blk = { type: 'tool_result', tool_use_id: m.tool_call_id || '', content: c };
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.length && last.content[last.content.length - 1].type === 'tool_result') {
        last.content.push(blk); // Anthropic 要求 tool_result 合并进同一个 user 轮次
      } else {
        msgs.push({ role: 'user', content: [blk] });
      }
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      const txt = typeof m.content === 'string' ? m.content : openaiContentText(m.content);
      if (txt) blocks.push({ type: 'text', text: txt });
      for (const t of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(t.function?.arguments || '{}'); } catch {}
        blocks.push({ type: 'tool_use', id: t.id || genId('toolu_'), name: t.function?.name || '', input });
      }
      if (blocks.length) msgs.push({ role: 'assistant', content: blocks });
      continue;
    }
    // user
    if (typeof m.content === 'string') { msgs.push({ role: 'user', content: m.content }); continue; }
    const blocks = [];
    for (const b of m.content || []) {
      if (!b) continue;
      if (b.type === 'text') blocks.push({ type: 'text', text: b.text || '' });
      else if (b.type === 'image_url') {
        const url = (b.image_url && b.image_url.url) || '';
        const dm = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(url);
        if (dm) blocks.push({ type: 'image', source: { type: 'base64', media_type: dm[1], data: dm[2] } });
        else if (url) blocks.push({ type: 'image', source: { type: 'url', url } });
      }
    }
    if (blocks.length) msgs.push({ role: 'user', content: blocks });
  }

  const out = { model: body.model, messages: msgs, max_tokens: body.max_tokens ?? 8192 };
  if (systemParts.length) out.system = systemParts.join('\n');
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map(t => ({ name: t.function?.name, description: t.function?.description || '', input_schema: t.function?.parameters || { type: 'object', properties: {} } }));
  }
  const tco = body.tool_choice;
  if (tco === 'required') out.tool_choice = { type: 'any' };
  else if (tco === 'auto') out.tool_choice = { type: 'auto' };
  else if (tco && typeof tco === 'object' && tco.type === 'function') out.tool_choice = { type: 'tool', name: tco.function?.name };
  if (body.stream) out.stream = true;
  return out;
}

/* ================= OpenAI 响应(JSON) -> Anthropic 响应(JSON) ================= */
function openaiRespToAnthropic(j) {
  const ch = (j.choices && j.choices[0]) || {};
  const m = ch.message || {};
  const content = [];
  if (m.reasoning_content) content.push({ type: 'thinking', thinking: String(m.reasoning_content), signature: '' });
  if (typeof m.content === 'string' && m.content) content.push({ type: 'text', text: m.content });
  else if (Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
  for (const t of m.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(t.function?.arguments || '{}'); } catch {}
    content.push({ type: 'tool_use', id: t.id || genId('toolu_'), name: t.function?.name || '', input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const fr = ch.finish_reason;
  const stop = fr === 'tool_calls' || fr === 'function_call' ? 'tool_use' : fr === 'length' ? 'max_tokens' : 'end_turn';
  const u = j.usage || {};
  const usage = { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 };
  const cached = u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens;
  if (cached != null) usage.cache_read_input_tokens = cached;
  return {
    id: j.id || genId('msg_'), type: 'message', role: 'assistant', model: j.model || '',
    content, stop_reason: stop, stop_sequence: null, usage,
  };
}

/* ================= 流式转换 ================= */
function sseOpenai(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }
function sseAnth(ev, data) { return 'event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n'; }

// Anthropic 事件流 -> OpenAI chunk 流（上游 anthropic，客户端 openai）
class AnthToOaiStream {
  constructor(model) {
    this.model = model || '';
    this.started = false;
    this.finish = 'stop';
    this.usageIn = 0; this.usageOut = 0;
    this.id = genId('chatcmpl-');
    this.toolIdx = new Map(); // anthropic block index -> openai tool index
    this.nextTool = 0;
    this.error = null;
  }
  chunk(delta, finish = null, extra) {
    return sseOpenai(Object.assign({
      id: this.id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }, extra || {}));
  }
  push(ev) {
    const out = [];
    if (!ev || typeof ev !== 'object') return out;
    if (ev.type === 'error') { this.error = (ev.error && ev.error.message) || '上游流式错误'; return out; }
    if (ev.type === 'message_start') {
      this.started = true;
      if (ev.message && ev.message.id) this.id = ev.message.id;
      if (ev.message && ev.message.model) this.model = ev.message.model;
      if (ev.message && ev.message.usage) this.usageIn = ev.message.usage.input_tokens ?? 0;
      out.push(this.chunk({ role: 'assistant', content: '' }));
      return out;
    }
    if (ev.type === 'content_block_start') {
      const b = ev.content_block || {};
      if (b.type === 'tool_use') {
        const ti = this.nextTool++;
        this.toolIdx.set(ev.index, ti);
        out.push(this.chunk({ tool_calls: [{ index: ti, id: b.id || genId('call_'), type: 'function', function: { name: b.name || '', arguments: '' } }] }));
      }
      return out;
    }
    if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta' && d.text) out.push(this.chunk({ content: d.text }));
      else if (d.type === 'thinking_delta' && d.thinking) out.push(this.chunk({ reasoning_content: d.thinking }));
      else if (d.type === 'input_json_delta' && d.partial_json) {
        const ti = this.toolIdx.has(ev.index) ? this.toolIdx.get(ev.index) : Math.max(0, this.nextTool - 1);
        out.push(this.chunk({ tool_calls: [{ index: ti, function: { arguments: d.partial_json } }] }));
      }
      return out;
    }
    if (ev.type === 'message_delta') {
      const sr = ev.delta && ev.delta.stop_reason;
      this.finish = sr === 'tool_use' ? 'tool_calls' : sr === 'max_tokens' ? 'length' : 'stop';
      if (ev.usage && ev.usage.output_tokens != null) this.usageOut = ev.usage.output_tokens;
      return out;
    }
    return out;
  }
  end() {
    const usage = { prompt_tokens: this.usageIn, completion_tokens: this.usageOut, total_tokens: this.usageIn + this.usageOut };
    return this.chunk({}, this.finish, { usage }) + 'data: [DONE]\n\n';
  }
}

// OpenAI chunk 流 -> Anthropic 事件流（上游 openai，客户端 anthropic，如 Claude Code）
class OaiToAnthStream {
  constructor(model) {
    this.model = model || '';
    this.started = false;
    this.nextBlock = 0;
    this.textIdx = null; this.thinkIdx = null;
    this.toolBlocks = new Map(); // openai tool index -> anthropic block index
    this.finish = 'end_turn';
    this.usageIn = 0; this.usageOut = 0;
    this.id = genId('msg_');
    this.error = null;
  }
  openBlock(type, extra) {
    const idx = this.nextBlock++;
    return { idx, frames: sseAnth('content_block_start', { type: 'content_block_start', index: idx, content_block: Object.assign({ type }, extra || {}) }) };
  }
  closeBlock(idx) {
    if (idx == null || !this._open(idx)) return '';
    return sseAnth('content_block_stop', { type: 'content_block_stop', index: idx });
  }
  _open() { return true; } // 简化：openBlock 后必然要 close
  push(chunk) {
    const out = [];
    if (!chunk || typeof chunk !== 'object') return out;
    if (chunk.error) { this.error = (chunk.error && chunk.error.message) || JSON.stringify(chunk.error); return out; }
    const u = chunk.usage;
    if (u) { this.usageIn = u.prompt_tokens ?? this.usageIn; this.usageOut = u.completion_tokens ?? this.usageOut; }
    if (!this.started) {
      this.started = true;
      if (chunk.id) this.id = chunk.id;
      if (chunk.model) this.model = chunk.model;
      out.push(sseAnth('message_start', { type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: this.usageIn, output_tokens: 0 } } }));
    }
    for (const ch of chunk.choices || []) {
      const d = ch.delta || {};
      if (d.reasoning_content) {
        if (this.thinkIdx == null) { const r = this.openBlock('thinking'); this.thinkIdx = r.idx; out.push(r.frames); }
        out.push(sseAnth('content_block_delta', { type: 'content_block_delta', index: this.thinkIdx, delta: { type: 'thinking_delta', thinking: d.reasoning_content } }));
      }
      if (typeof d.content === 'string' && d.content) {
        if (this.textIdx == null) { const r = this.openBlock('text', { text: '' }); this.textIdx = r.idx; out.push(r.frames); }
        out.push(sseAnth('content_block_delta', { type: 'content_block_delta', index: this.textIdx, delta: { type: 'text_delta', text: d.content } }));
      } else if (Array.isArray(d.content)) {
        for (const b of d.content) {
          if (b && b.type === 'text' && b.text) {
            if (this.textIdx == null) { const r = this.openBlock('text', { text: '' }); this.textIdx = r.idx; out.push(r.frames); }
            out.push(sseAnth('content_block_delta', { type: 'content_block_delta', index: this.textIdx, delta: { type: 'text_delta', text: b.text } }));
          }
        }
      }
      for (const tc of d.tool_calls || []) {
        const oi = tc.index ?? 0;
        if (!this.toolBlocks.has(oi)) {
          const r = this.openBlock('tool_use', { id: tc.id || genId('toolu_'), name: (tc.function && tc.function.name) || '', input: {} });
          this.toolBlocks.set(oi, r.idx);
          out.push(r.frames);
        }
        if (tc.function && tc.function.arguments) {
          out.push(sseAnth('content_block_delta', { type: 'content_block_delta', index: this.toolBlocks.get(oi), delta: { type: 'input_json_delta', partial_json: tc.function.arguments } }));
        }
      }
      if (ch.finish_reason) {
        const fr = ch.finish_reason;
        this.finish = fr === 'tool_calls' || fr === 'function_call' ? 'tool_use' : fr === 'length' ? 'max_tokens' : 'end_turn';
      }
    }
    return out;
  }
  end() {
    let out = '';
    if (!this.started) {
      out += sseAnth('message_start', { type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    }
    if (this.thinkIdx != null) out += this.closeBlock(this.thinkIdx);
    if (this.textIdx != null) out += this.closeBlock(this.textIdx);
    for (const idx of this.toolBlocks.values()) out += this.closeBlock(idx);
    out += sseAnth('message_delta', { type: 'message_delta', delta: { stop_reason: this.finish, stop_sequence: null }, usage: { output_tokens: this.usageOut } });
    out += sseAnth('message_stop', { type: 'message_stop' });
    return out;
  }
}

module.exports = { anthropicReqToOpenai, anthropicRespToOpenai, openaiReqToAnthropic, openaiRespToAnthropic, AnthToOaiStream, OaiToAnthStream, sseAnth };
