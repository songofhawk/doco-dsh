// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { getGlobalDispatcher } from 'undici';
import { resolveConfig, validateProxyUrl } from '../src/config.js';
import { createState, reconfigure } from '../src/context.js';
import { createTransport } from '../src/transport.js';

test('代理配置：默认直连，参数覆盖环境变量，空串显式关闭代理', () => {
  assert.equal(resolveConfig({}, {}).proxyUrl, '');
  assert.equal(resolveConfig({}, { DOCO_PROXY_URL: 'http://127.0.0.1:7890' }).proxyUrl, 'http://127.0.0.1:7890/');
  assert.equal(resolveConfig({ proxyUrl: 'https://proxy.test:8443' }, {
    DOCO_PROXY_URL: 'http://127.0.0.1:7890',
  }).proxyUrl, 'https://proxy.test:8443/');
  assert.equal(resolveConfig({ proxyUrl: '' }, { DOCO_PROXY_URL: 'http://127.0.0.1:7890' }).proxyUrl, '');
});

test('代理校验：拒绝非法协议/格式且错误中不泄露代理凭据', () => {
  assert.equal(validateProxyUrl('  '), '');
  assert.equal(validateProxyUrl(' http://user:p%40ss@localhost:7890 '), 'http://user:p%40ss@localhost:7890/');
  for (const value of [123, 'localhost:7890', 'socks5://user:secret@localhost:1080',
    'http://user:secret@localhost:bad', 'http://user:secret@localhost/path',
    'http://localhost/?password=secret', 'http://localhost/#secret', 'http://user:%ZZ@localhost']) {
    assert.throws(() => resolveConfig({ proxyUrl: value }, {}), (error) => {
      assert.equal(error.code, 'doco_invalid_proxy_url');
      assert.equal(error.details.config, 'DOCO_PROXY_URL');
      assert.doesNotMatch(error.message, /secret|%ZZ/);
      return true;
    });
  }
});

test('直连保留原 fetch，代理 wrapper 保留 HTTPS URL、body、signal 且不修改全局 dispatcher', async () => {
  const calls = [];
  const fetch = async (...args) => { calls.push(args); return new Response('{}'); };
  assert.equal(createTransport('', fetch).fetch, fetch);
  const globalDispatcher = getGlobalDispatcher();
  const transport = createTransport('https://proxy.test:8443/', fetch);
  try {
    const signal = new AbortController().signal;
    await transport.fetch('https://api.doco.page/api/v1/me', { method: 'POST', body: 'data', signal });
    assert.equal(calls[0][0], 'https://api.doco.page/api/v1/me');
    assert.equal(calls[0][1].signal, signal);
    assert.equal(calls[0][1].body, 'data');
    assert.ok(calls[0][1].dispatcher);
    assert.equal(getGlobalDispatcher(), globalDispatcher);
  } finally {
    await transport.dispose();
  }
});

/** 本地 CONNECT 代理：目标端口故意不可直连，只有通过代理才能得到 API 响应。 */
async function proxyFixture(t) {
  const requests = [];
  const tunnels = [];
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  };
  const origin = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"v2"' });
    res.end(JSON.stringify({ data: { ok: true } }));
  });
  const proxy = createServer((req, res) => res.writeHead(405).end());
  origin.on('connection', track);
  proxy.on('connection', track);
  proxy.on('connect', (req, socket, head) => {
    tunnels.push({ target: req.url, headers: req.headers });
    const upstream = connect(origin.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    track(upstream);
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise((resolve) => proxy.close(resolve)), new Promise((resolve) => origin.close(resolve))]);
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  return { proxyUrl: `http://127.0.0.1:${proxy.address().port}`, requests, tunnels };
}

test('真实 CONNECT：读取、匿名设备授权、写入都经过带认证代理，凭据不进入 API 请求', { timeout: 10000 }, async (t) => {
  const proxy = await proxyFixture(t);
  const state = createState(resolveConfig({
    baseUrl: 'http://localhost:54321/api/v1', token: 'test-token',
    proxyUrl: proxy.proxyUrl.replace('http://', 'http://alice:p%40ss@'),
  }, {}));
  t.after(() => state.dispose());
  assert.deepEqual((await state.client.me()).data, { ok: true });
  await state.client.withToken('').requestDeviceCode({ clientName: 'test', scopes: 'read_only' });
  const result = await state.client.request('PATCH', '/documents/doc1/blocks/b1', {
    body: { attrs: { checked: true } }, headers: { 'If-Match': '"v1"' },
  });
  assert.equal(result.etag, '"v2"');
  assert.ok(proxy.tunnels.length >= 1);
  for (const tunnel of proxy.tunnels) {
    assert.equal(tunnel.target, 'localhost:54321');
    assert.equal(tunnel.headers['proxy-authorization'], `Basic ${Buffer.from('alice:p@ss').toString('base64')}`);
    assert.equal(tunnel.headers.authorization, undefined);
  }
  assert.deepEqual(proxy.requests.map((r) => [r.method, r.url]), [
    ['GET', '/api/v1/me'], ['POST', '/api/v1/auth/device/code'], ['PATCH', '/api/v1/documents/doc1/blocks/b1'],
  ]);
  assert.equal(proxy.requests[0].headers.authorization, 'Bearer test-token');
  assert.equal(proxy.requests[1].headers.authorization, undefined);
  assert.deepEqual(JSON.parse(proxy.requests[1].body), { client_name: 'test', scopes: 'read_only' });
  assert.equal(proxy.requests[2].headers['if-match'], '"v1"');
  assert.deepEqual(JSON.parse(proxy.requests[2].body), { attrs: { checked: true } });
  for (const req of proxy.requests) assert.equal(req.headers['proxy-authorization'], undefined);
});

test('重配保留/切换/关闭代理，释放旧 dispatcher；配置非法时保留可用客户端', async () => {
  const dispatchers = [];
  const impl = { fetch: async (_url, init) => {
    dispatchers.push(init.dispatcher);
    return new Response('{"data":{}}');
  } };
  const state = createState(resolveConfig({ proxyUrl: 'http://localhost:7890' }, {}), impl);
  try {
    await state.client.me();
    reconfigure(state, { token: 'new-token' }, resolveConfig, impl);
    await state.client.me();
    assert.equal(dispatchers[0].closed, true);
    assert.notEqual(dispatchers[1], dispatchers[0]);
    assert.equal(state.config.proxyUrl, 'http://localhost:7890/');
    reconfigure(state, { proxyUrl: 'https://localhost:8443' }, resolveConfig, impl);
    await state.client.me();
    assert.equal(state.config.proxyUrl, 'https://localhost:8443/');
    const client = state.client;
    assert.throws(() => reconfigure(state, { proxyUrl: 'socks5://localhost' }, resolveConfig, impl));
    assert.equal(state.client, client);
    assert.equal(dispatchers[2].closed, false);
    reconfigure(state, { proxyUrl: '' }, resolveConfig, impl);
    await state.client.me();
    assert.equal(dispatchers[2].closed, true);
    assert.equal(dispatchers[3], undefined);
  } finally {
    await state.dispose();
  }
});

test('卸载清理当前代理连接池', async () => {
  let dispatcher;
  const state = createState(resolveConfig({ proxyUrl: 'http://localhost:7890' }, {}), {
    fetch: async (_url, init) => {
      dispatcher = init.dispatcher;
      return new Response('{"data":{}}');
    },
  });
  await state.client.me();
  assert.equal(dispatcher.closed, false);
  await state.dispose();
  assert.equal(dispatcher.closed, true);
  await state.dispose(); // 多次清理安全
});

test('代理不可用时返回网络错误，不退回直连', { timeout: 5000 }, async () => {
  let calls = 0;
  const state = createState(resolveConfig({ proxyUrl: 'http://localhost:7890' }, {}), {
    fetch: async (_url, init) => {
      calls++;
      assert.ok(init.dispatcher);
      throw new TypeError('fetch failed');
    },
  });
  try {
    await assert.rejects(() => state.client.me(), (error) => error.code === 'network_error');
    assert.equal(calls, 1);
  } finally {
    await state.dispose();
  }
});
