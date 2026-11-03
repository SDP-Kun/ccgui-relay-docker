import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRelayServer } from '../src/server.js';

const KEY = 'test-key-0123456789abcdef';

async function start(t, options = {}) {
  const app = createRelayServer({ relayKey: KEY, log: () => {}, ...options });
  const port = await app.listen(0, '127.0.0.1');
  // A failed assertion must not leave the server holding the event loop open.
  t.after(() => app.close());
  const base = `127.0.0.1:${port}`;
  return { app, http: `http://${base}`, ws: `ws://${base}` };
}

/** Connect as the desktop agent and collect the frames it receives. */
function openAgent(wsUrl, key = KEY) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}/agent?key=${key}`);
    const frames = [];
    const waiters = [];
    const pump = () => {
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        const index = frames.findIndex(waiter.pred);
        if (index === -1) continue;
        const [frame] = frames.splice(index, 1);
        waiters.splice(i, 1);
        waiter.resolve(frame);
      }
    };
    ws.on('message', (data) => {
      frames.push(JSON.parse(data.toString()));
      pump();
    });
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        frames,
        /** Resolve with the first (already received or future) frame matching pred. */
        next(pred) {
          const index = frames.findIndex(pred);
          if (index !== -1) return Promise.resolve(frames.splice(index, 1)[0]);
          return new Promise((res) => waiters.push({ pred, resolve: res }));
        },
        send: (frame) => ws.send(JSON.stringify(frame)),
        close: () => ws.close(),
      }),
    );
  });
}

function expectRefused(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timed out waiting for a refusal'));
    }, 2000);
    const done = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    ws.on('unexpected-response', (_req, res) => {
      done(res.statusCode);
      ws.terminate();
    });
    ws.on('error', (err) => {
      if (/Unexpected server response: \d+/.test(err.message)) done(Number(err.message.match(/\d+/)[0]));
      else {
        clearTimeout(timer);
        reject(err);
      }
    });
    ws.on('open', () => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error('connection unexpectedly opened'));
    });
  });
}

const b64 = (text) => Buffer.from(text).toString('base64');
const unb64 = (text) => Buffer.from(text, 'base64');

test('healthz reports readiness and agent state', async (t) => {
  const { app, http, ws } = await start(t);
  const before = await fetch(`${http}/healthz`);
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), { ok: true, agent: false });

  const agent = await openAgent(ws);
  const after = await fetch(`${http}/healthz`);
  assert.deepEqual(await after.json(), { ok: true, agent: true });

  agent.close();
});

test('phone requests get 503 while no desktop is attached', async (t) => {
  const { app, http } = await start(t);
  const res = await fetch(`${http}/`);
  assert.equal(res.status, 503);
  assert.match(await res.text(), /未连接到中继/);
});

test('the agent path refuses a wrong key', async (t) => {
  const { app, ws } = await start(t);
  assert.equal(await expectRefused(`${ws}/agent?key=wrong`), 403);
});

test('the agent path refuses a plain HTTP request', async (t) => {
  const { app, http } = await start(t);
  const res = await fetch(`${http}/agent?key=${KEY}`);
  assert.equal(res.status, 426);
});

test('tunnels an HTTP request and its response through the agent', async (t) => {
  const { app, http, ws } = await start(t);
  const agent = await openAgent(ws);

  const responsePromise = fetch(`${http}/hello?x=1`, { headers: { 'x-phone': 'yes' } });
  const open = await agent.next((f) => f.t === 'open');
  assert.equal(open.method, 'GET');
  assert.equal(open.path, '/hello?x=1');
  assert.equal(open.headers['x-phone'], 'yes');
  assert.equal(open.headers.host, undefined);
  await agent.next((f) => f.t === 'end' && f.id === open.id);

  agent.send({ t: 'head', id: open.id, status: 200, headers: { 'content-type': 'text/plain', 'x-test': 'yes' } });
  agent.send({ t: 'data', id: open.id, b64: b64('hello from desktop') });
  agent.send({ t: 'close', id: open.id });

  const res = await responsePromise;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-test'), 'yes');
  assert.equal(await res.text(), 'hello from desktop');
  agent.close();
});

test('forwards a POST body to the agent', async (t) => {
  const { app, http, ws } = await start(t);
  const agent = await openAgent(ws);

  const payload = 'name=ccgui&mode=relay';
  const responsePromise = fetch(`${http}/submit`, {
    method: 'POST',
    body: payload,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const open = await agent.next((f) => f.t === 'open');
  assert.equal(open.method, 'POST');
  const body = await agent.next((f) => f.t === 'body' && f.id === open.id);
  assert.equal(unb64(body.b64).toString(), payload);
  await agent.next((f) => f.t === 'end' && f.id === open.id);

  agent.send({ t: 'head', id: open.id, status: 201, headers: { 'content-type': 'text/plain' } });
  agent.send({ t: 'data', id: open.id, b64: b64('created') });
  agent.send({ t: 'close', id: open.id });

  const res = await responsePromise;
  assert.equal(res.status, 201);
  assert.equal(await res.text(), 'created');
  agent.close();
});

test('preserves multiple set-cookie headers', async (t) => {
  const { app, http, ws } = await start(t);
  const agent = await openAgent(ws);

  const responsePromise = fetch(`${http}/login`);
  const open = await agent.next((f) => f.t === 'open');
  agent.send({
    t: 'head',
    id: open.id,
    status: 200,
    headers: { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'], 'content-type': 'text/plain' },
  });
  agent.send({ t: 'close', id: open.id });

  const res = await responsePromise;
  assert.deepEqual(res.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
  await res.text();
  agent.close();
});

test('answers 504 and closes the stream when the agent never sends a head', async (t) => {
  const { app, http, ws } = await start(t, { headTimeoutMs: 100 });
  const agent = await openAgent(ws);

  const responsePromise = fetch(`${http}/slow`);
  const open = await agent.next((f) => f.t === 'open');
  await agent.next((f) => f.t === 'end' && f.id === open.id);

  const res = await responsePromise;
  assert.equal(res.status, 504);
  const close = await agent.next((f) => f.t === 'close' && f.id === open.id);
  assert.equal(close.id, open.id);
  agent.close();
});

test('answers 502 when the agent stream closes before the head', async (t) => {
  const { app, http, ws } = await start(t);
  const agent = await openAgent(ws);

  const responsePromise = fetch(`${http}/boom`);
  const open = await agent.next((f) => f.t === 'open');
  agent.send({ t: 'error', id: open.id, message: 'upstream exploded' });

  const res = await responsePromise;
  assert.equal(res.status, 502);
  assert.match(await res.text(), /upstream exploded/);
  agent.close();
});

test('rejects a request body larger than MAX_BODY_BYTES', async (t) => {
  const { app, http, ws } = await start(t, { maxBodyBytes: 4 });
  const agent = await openAgent(ws);

  const res = await fetch(`${http}/upload`, { method: 'POST', body: 'too large' });
  assert.equal(res.status, 413);
  assert.equal(agent.frames.some((f) => f.t === 'open'), false);
  agent.close();
});

test('tunnels a live WebSocket in both directions', async (t) => {
  const { app, ws } = await start(t);
  const agent = await openAgent(ws);

  const phone = new WebSocket(`${ws}/ws?token=abc`);
  await once(phone, 'open');
  const open = await agent.next((f) => f.t === 'open');
  assert.equal(open.ws, true);
  assert.equal(open.path, '/ws?token=abc');

  phone.send('ping');
  const inbound = await agent.next((f) => f.t === 'data' && f.id === open.id);
  assert.equal(inbound.text, true);
  assert.equal(unb64(inbound.b64).toString(), 'ping');

  agent.send({ t: 'data', id: open.id, b64: b64('pong'), text: true });
  const [message] = await once(phone, 'message');
  assert.equal(message.toString(), 'pong');

  phone.send(Buffer.from([1, 2, 3]));
  const binary = await agent.next((f) => f.t === 'data' && f.id === open.id);
  assert.equal(binary.text, false);
  assert.deepEqual([...unb64(binary.b64)], [1, 2, 3]);

  agent.send({ t: 'close', id: open.id });
  await once(phone, 'close');
  agent.close();
});

test('does not forward the websocket handshake headers to the agent', async (t) => {
  const { app, ws } = await start(t);
  const agent = await openAgent(ws);

  const phone = new WebSocket(`${ws}/ws`, { headers: { 'x-custom': 'yes' } });
  await once(phone, 'open');
  const open = await agent.next((f) => f.t === 'open');

  assert.equal(open.headers['x-custom'], 'yes');
  assert.equal(open.headers['sec-websocket-key'], undefined);
  assert.equal(open.headers['sec-websocket-version'], undefined);
  assert.equal(open.headers['sec-websocket-extensions'], undefined);

  phone.close();
  agent.close();
});

test('a reconnecting agent replaces the old socket', async (t) => {
  const { app, http, ws } = await start(t);
  const first = await openAgent(ws);
  const firstClosed = once(first.ws, 'close');

  const second = await openAgent(ws);
  const [code] = await firstClosed;
  assert.equal(code, 1012);

  const responsePromise = fetch(`${http}/after-reconnect`);
  const open = await second.next((f) => f.t === 'open');
  assert.equal(open.path, '/after-reconnect');
  second.send({ t: 'head', id: open.id, status: 200, headers: {} });
  second.send({ t: 'close', id: open.id });
  assert.equal((await responsePromise).status, 200);

  second.close();
});

test('closing the agent fails every stream in flight', async (t) => {
  const { app, http, ws } = await start(t);
  const agent = await openAgent(ws);

  const responsePromise = fetch(`${http}/inflight`);
  await agent.next((f) => f.t === 'open');
  agent.close();

  const res = await responsePromise;
  assert.equal(res.status, 502);
});