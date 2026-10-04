'use strict';
// 零依赖的出站代理 fetch：让上游请求经 HTTP(S)/SOCKS5 代理转发。
// 支持 http:// https:// socks5:// socks5h://user:pass@host:port，统一走 CONNECT 隧道
// （socks5 在本地解析域名，socks5h 由代理解析）；https 目标在隧道上再做 TLS（SNI 正常）。
// 返回 fetch 风格的 Response（ok/status/headers.get/text/json/body），body 为
// Web ReadableStream，供 server.js 的 SSE 嗅探与管道直接复用。

const http = require('http');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const { Readable } = require('stream');

const parsedCache = new Map();
function parseProxy(str) {
  str = String(str || '').trim();
  if (parsedCache.has(str)) return parsedCache.get(str);
  let u;
  try { u = new URL(str); } catch { throw new Error('代理地址不合法: ' + str); }
  const proto = u.protocol.replace(/:$/, '').toLowerCase();
  const socks = proto === 'socks5' || proto === 'socks5h' || proto === 'socks';
  if (proto !== 'http' && proto !== 'https' && !socks)
    throw new Error('不支持的代理协议: ' + u.protocol + '（支持 http/https/socks5/socks5h）');
  if (!u.hostname) throw new Error('代理地址缺少主机: ' + str);
  const out = {
    proto, socks,
    host: u.hostname,
    port: Number(u.port) || (socks ? 1080 : proto === 'https' ? 443 : 80),
    user: u.username ? decodeURIComponent(u.username) : '',
    pass: u.password ? decodeURIComponent(u.password) : '',
    remoteDns: proto === 'socks5h' || proto === 'socks',
  };
  parsedCache.set(str, out);
  return out;
}

function abortErr() { const e = new Error('Aborted'); e.name = 'AbortError'; return e; }
function tlsSecure() { return process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0'; }
// SNI：IP 目标不设 servername（RFC 6066 不允许，Node 也会告警）
function sni(host) { return net.isIP(host) ? undefined : host; }

// 单次使用的 Agent：把请求装进一条已建好的隧道 socket
class TunnelAgent extends http.Agent {
  constructor(sock) { super({ keepAlive: false, maxSockets: 1 }); this._sock = sock; }
  createConnection(opts, cb) { cb(null, this._sock); }
}

function tcpConnect(proxy, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    let done = false;
    const to = setTimeout(() => fail(new Error('连接代理超时（' + proxy.host + ':' + proxy.port + '）')), timeoutMs);
    const fail = e => { if (done) return; done = true; clearTimeout(to); sock.destroy(); reject(e); };
    sock.once('connect', () => { if (done) return; done = true; clearTimeout(to); sock.setTimeout(0); resolve(sock); });
    sock.once('error', e => fail(new Error('连接代理失败（' + proxy.host + ':' + proxy.port + '）: ' + e.message)));
    if (signal) {
      if (signal.aborted) return fail(abortErr());
      signal.addEventListener('abort', () => fail(abortErr()), { once: true });
    }
  });
}

// 收集到 marker（如 '\r\n\r\n'）为止，返回其之前的全部文本
function readUntil(sock, marker, signal) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onErr = e => { cleanup(); reject(e); };
    const onClose = () => onErr(new Error('代理连接被提前关闭'));
    const onData = d => {
      buf += d.toString('latin1');
      const i = buf.indexOf(marker);
      if (i === -1) return;
      cleanup();
      resolve(buf.slice(0, i));
    };
    const onAbort = () => onErr(abortErr());
    function cleanup() { sock.off('data', onData); sock.off('error', onErr); sock.off('close', onClose); if (signal) signal.removeEventListener('abort', onAbort); }
    sock.on('data', onData);
    sock.once('error', onErr);
    sock.once('close', onClose);
    if (signal) {
      if (signal.aborted) return onErr(abortErr());
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// 握手期按字节读：剩余字节留在缓冲里传给下一次读取（不能用 socket.unshift，
// 它会破坏流状态，导致后续 http.request 挂死）
function makeReader(sock) {
  let pending = Buffer.alloc(0);
  return function read(n, label) {
    return new Promise((resolve, reject) => {
      const take = () => {
        if (pending.length < n) return false;
        const out = pending.subarray(0, n);
        pending = pending.subarray(n);
        resolve(out);
        return true;
      };
      if (take()) return;
      const onData = d => { pending = pending.length ? Buffer.concat([pending, d]) : d; if (take()) cleanup(); };
      const onErr = e => { cleanup(); reject(e); };
      const onClose = () => { cleanup(); reject(new Error((label || 'SOCKS5') + '握手时连接被关闭')); };
      function cleanup() { sock.off('data', onData); sock.off('error', onErr); sock.off('close', onClose); }
      sock.on('data', onData);
      sock.once('error', onErr);
      sock.once('close', onClose);
    });
  };
}

async function httpProxyConnect(proxy, host, port, signal) {
  let sock = await tcpConnect(proxy, signal, 20000);
  if (proxy.proto === 'https') { // 代理本身是 https：先和代理做 TLS
    sock = await new Promise((resolve, reject) => {
      const t = tls.connect({ socket: sock, servername: sni(proxy.host), rejectUnauthorized: tlsSecure() });
      const to = setTimeout(() => { t.destroy(); reject(new Error('代理 TLS 握手超时')); }, 15000);
      t.once('secureConnect', () => { clearTimeout(to); resolve(t); });
      t.once('error', e => { clearTimeout(to); reject(new Error('代理 TLS 握手失败: ' + e.message)); });
    });
  }
  sock.on('error', () => {}); // 之后的错误由请求方处理，防止 unhandled
  const head = 'CONNECT ' + host + ':' + port + ' HTTP/1.1\r\n'
    + 'Host: ' + host + ':' + port + '\r\n'
    + (proxy.user ? 'Proxy-Authorization: Basic ' + Buffer.from(proxy.user + ':' + proxy.pass).toString('base64') + '\r\n' : '')
    + '\r\n';
  sock.write(head);
  const reply = await readUntil(sock, '\r\n\r\n', signal);
  if (!/^HTTP\/1\.\d 2\d\d/.test(reply))
    throw new Error('代理拒绝 CONNECT（' + host + ':' + port + '）: ' + reply.split('\r\n')[0]);
  return sock;
}

const SOCKS_ERR = { 1: '一般性失败', 2: '规则不允许', 3: '网络不可达', 4: '主机不可达', 5: '连接被拒绝', 6: 'TTL 过期', 7: '命令不支持', 8: '地址类型不支持' };

async function socks5Connect(proxy, host, port, signal) {
  const sock = await tcpConnect(proxy, signal, 20000);
  sock.on('error', () => {});
  const read = makeReader(sock);
  const to = setTimeout(() => sock.destroy(new Error('SOCKS5 握手超时')), 20000);
  try {
    const methods = proxy.user ? [0, 2] : [0];
    sock.write(Buffer.from([5, methods.length, ...methods]));
    let r = await read(2, 'SOCKS5');
    if (r[0] !== 5) throw new Error('SOCKS5 握手失败：协议版本异常');
    if (r[1] === 0xFF) throw new Error('SOCKS5 握手失败：代理不接受任何认证方式');
    if (r[1] === 2) {
      if (!proxy.user) throw new Error('SOCKS5 代理要求用户名/密码（写法 socks5://user:pass@host:port）');
      const ub = Buffer.from(proxy.user, 'utf8'), pb = Buffer.from(proxy.pass, 'utf8');
      sock.write(Buffer.concat([Buffer.from([1, ub.length]), ub, Buffer.from([pb.length]), pb]));
      r = await read(2, 'SOCKS5');
      if (r[1] !== 0) throw new Error('SOCKS5 用户名/密码认证失败');
    } else if (r[1] !== 0 && r[1] !== 2) {
      throw new Error('SOCKS5 握手失败：不支持的认证方式 ' + r[1]);
    } else if (r[1] === 0 && proxy.user) {
      // 代理选择了免认证，继续
    }

    // 地址：IPv4 字面量用 atyp1；socks5 先本地解析（拿到 IPv4 就用），其余一律 atyp3 域名
    let atyp = 3, addr = Buffer.from(host, 'utf8');
    if (net.isIP(host) === 4) {
      atyp = 1; addr = Buffer.from(host.split('.').map(Number));
    } else if (!proxy.remoteDns) {
      try {
        const lk = await dns.promises.lookup(host);
        if (lk.family === 4) { atyp = 1; addr = Buffer.from(lk.address.split('.').map(Number)); }
      } catch { /* 解析不了就交给代理按域名处理 */ }
    }
    const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(port);
    sock.write(Buffer.concat([
      Buffer.from([5, 1, 0, atyp]),
      atyp === 3 ? Buffer.from([addr.length]) : Buffer.alloc(0),
      addr, portBuf,
    ]));
    r = await read(4, 'SOCKS5');
    if (r[1] !== 0) throw new Error('SOCKS5 CONNECT 失败: ' + (SOCKS_ERR[r[1]] || '错误码 ' + r[1]));
    if (r[3] === 1) await read(6, 'SOCKS5');
    else if (r[3] === 4) await read(18, 'SOCKS5');
    else if (r[3] === 3) { const l = (await read(1, 'SOCKS5'))[0]; await read(l + 2, 'SOCKS5'); }
    return sock;
  } catch (e) {
    try { sock.destroy(); } catch {}
    throw e;
  } finally {
    clearTimeout(to);
  }
}

// 在已建立的隧道 socket 上发 HTTP 请求；https 目标先在隧道上做 TLS
function requestOverSocket(sock, url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const port = Number(u.port) || (isHttps ? 443 : 80);
    const headers = { ...(opts.headers || {}) };
    headers.host = u.hostname + (u.port && u.port !== '80' && u.port !== '443' ? ':' + u.port : '');
    headers.connection = headers.connection || 'close';
    let bodyBuf = null;
    if (opts.body != null) {
      bodyBuf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body), 'utf8');
      if (headers['content-length'] == null) headers['content-length'] = bodyBuf.length;
    }

    const start = socket => {
      const req = http.request({
        host: u.hostname, port, path: u.pathname + u.search,
        method: opts.method || 'GET', headers, agent: new TunnelAgent(socket),
      }, resolve);
      req.on('error', reject);
      if (opts.signal) {
        const onAbort = () => req.destroy(abortErr());
        if (opts.signal.aborted) return req.destroy(abortErr());
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    };

    if (isHttps) {
      const t = tls.connect({ socket: sock, servername: sni(u.hostname), rejectUnauthorized: tlsSecure() });
      t.once('secureConnect', () => start(t));
      t.once('error', e => reject(new Error('TLS 握手失败（' + u.hostname + '）: ' + e.message)));
    } else start(sock);
  });
}

function toWebResponse(res) {
  const hs = res.headers;
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: res.statusMessage || '',
    headers: {
      get(n) {
        const v = hs[String(n).toLowerCase()];
        return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v);
      },
    },
    text() {
      return new Promise((resolve, reject) => {
        const c = [];
        res.on('data', d => c.push(d));
        res.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
        res.on('error', reject);
      });
    },
    async json() { return JSON.parse(await this.text()); },
    body: Readable.toWeb(res),
  };
}

async function once(url, opts, proxy) {
  const u = new URL(url);
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const sock = proxy.socks
    ? await socks5Connect(proxy, u.hostname, port, opts.signal)
    : await httpProxyConnect(proxy, u.hostname, port, opts.signal);
  try {
    return toWebResponse(await requestOverSocket(sock, url, opts));
  } catch (e) {
    try { sock.destroy(); } catch {}
    throw e;
  }
}

// 代理版 fetch：含有限重定向（301/302/303 转 GET，307/308 原方法重发）
async function proxyFetch(url, opts = {}, proxyStr) {
  const proxy = parseProxy(proxyStr);
  let cur = url, curOpts = opts, hops = 0;
  while (true) {
    const resp = await once(cur, curOpts, proxy);
    const loc = resp.headers.get('location');
    if (loc && [301, 302, 303, 307, 308].includes(resp.status) && hops < 5) {
      try { await resp.text(); } catch {}
      hops++;
      let method = curOpts.method || 'GET';
      let body = curOpts.body;
      if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
      curOpts = { ...curOpts, method, body };
      cur = new URL(loc, cur).toString();
      continue;
    }
    return resp;
  }
}

module.exports = { proxyFetch, parseProxy };
