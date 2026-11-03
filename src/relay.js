/**
 * CC GUI relay, ported from the Cloudflare Worker/Durable Object version to a
 * plain Node process.
 *
 * The wire protocol is unchanged: the desktop dials /agent?key=<secret> and
 * keeps one WebSocket open; every phone request becomes a named stream on that
 * socket. This process holds exactly one Relay (the Worker keyed each Durable
 * Object by RELAY_KEY, and a self-hosted deployment has one key).
 */

const AGENT_PATH = '/agent';

// Headers the Worker dropped when forwarding a request. `host` must not leak,
// and the TLS/edge headers only exist on the Cloudflare hop.
const REQUEST_SKIP = new Set(['host', 'cf-connecting-ip', 'cf-ray', 'upgrade', 'connection']);

// The handshake headers describe *our* hop to the phone, so they must not be
// replayed to the desktop's bridge (matching the Worker's tunnelSocket).
const WS_SKIP = new Set([
  ...REQUEST_SKIP,
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
]);

// Hop-by-hop response headers must not be copied into our own response.
const RESPONSE_SKIP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const TEXT = { 'content-type': 'text/plain; charset=utf-8' };
const AGENT_DOWN =
  'CC GUI 桌面端未连接到中继。请在电脑上打开 CC GUI → 设置 → 远程访问 → 外网访问，启动中转。';

export class Relay {
  constructor({ headTimeoutMs = 30000, maxBodyBytes = 64 * 1024 * 1024, log = () => {} } = {}) {
    this.headTimeoutMs = headTimeoutMs;
    this.maxBodyBytes = maxBodyBytes;
    this.log = log;
    /** @type {import('ws').WebSocket | null} */
    this.agent = null;
    this.nextId = 1;
    /** @type {Map<number, (kind: string, frame: any) => void>} */
    this.streams = new Map();
  }

  hasAgent() {
    // 1 === WebSocket.OPEN; avoiding an import keeps this module transport-agnostic.
    return this.agent?.readyState === 1;
  }

  send(frame) {
    if (this.hasAgent()) this.agent.send(JSON.stringify(frame));
  }

  /** Take over the desktop connection; the old one must never interleave. */
  attachAgent(ws) {
    const previous = this.agent;
    this.agent = ws;
    if (previous && previous !== ws) {
      try {
        previous.close(1012, 'replaced by a new agent connection');
      } catch {}
    }
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (data, isBinary) => this.onAgentFrame(isBinary ? data : data.toString()));
    ws.on('close', () => this.detachAgent(ws));
    ws.on('error', () => {});
    this.log('agent connected');
  }

  detachAgent(ws) {
    // A replaced socket closing late must not clear the socket that replaced it.
    if (this.agent !== ws) return;
    this.agent = null;
    this.log('agent disconnected');
    for (const deliver of [...this.streams.values()]) deliver('close', {});
    this.streams.clear();
  }

  onAgentFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }
    this.streams.get(frame.id)?.(frame.t, frame);
  }

  /** Phone HTTP request: request head + body in, response head + chunks out. */
  async handleHttp(req, res) {
    if (!this.hasAgent()) return sendText(res, 503, AGENT_DOWN);

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      res.setHeader('connection', 'close');
      return sendText(res, 413, 'request body too large');
    }

    let body;
    try {
      body = await readBody(req, this.maxBodyBytes);
    } catch (error) {
      res.setHeader('connection', 'close');
      return sendText(res, error.code === 'E_BODY_TOO_LARGE' ? 413 : 400, error.message);
    }

    // The body may have taken long enough for the desktop to drop.
    if (!this.hasAgent()) return sendText(res, 503, AGENT_DOWN);

    const id = this.nextId++;
    const state = { headWritten: false, ended: false, timer: null, id };
    const queued = [];

    const writeHead = (status, headers) => {
      if (state.headWritten || state.ended) return;
      state.headWritten = true;
      try {
        res.writeHead(status, sanitizeResponseHeaders(headers));
      } catch {
        state.headWritten = true;
        try {
          res.writeHead(502, TEXT);
          res.end('relay received invalid response headers');
        } catch {}
        return false;
      }
      for (const chunk of queued.splice(0)) {
        try {
          res.write(chunk);
        } catch {}
      }
      return true;
    };

    const finish = (message) => {
      if (state.ended) return;
      state.ended = true;
      if (state.timer) clearTimeout(state.timer);
      try {
        res.end(message);
      } catch {}
    };

    const deliver = (kind, frame) => {
      if (kind === 'head') {
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
        }
        writeHead(frame.status ?? 502, frame.headers ?? {});
        return;
      }
      if (kind === 'data') {
        const bytes = Buffer.from(frame.b64 ?? '', 'base64');
        if (state.headWritten && !state.ended) {
          try {
            res.write(bytes);
          } catch {}
        } else {
          queued.push(bytes);
        }
        return;
      }
      if (kind === 'close' || kind === 'error') {
        this.streams.delete(id);
        if (!state.headWritten) {
          writeHead(502, TEXT);
          finish(frame?.message ?? 'relay stream closed');
        } else {
          finish();
        }
      }
    };

    this.streams.set(id, deliver);

    // A head that never comes back must still release the stream, as in the
    // Worker version (30s default).
    state.timer = setTimeout(() => {
      if (!this.streams.delete(id)) return;
      this.send({ t: 'close', id });
      if (!state.headWritten) writeHead(504, TEXT);
      finish();
    }, this.headTimeoutMs);
    state.timer.unref?.();

    // The phone hanging up must tell the desktop to stop working on this stream.
    res.on('close', () => {
      if (this.streams.delete(id)) this.send({ t: 'close', id });
      if (state.timer) clearTimeout(state.timer);
    });

    this.send({
      t: 'open',
      id,
      method: req.method,
      path: req.url,
      headers: collectRequestHeaders(req),
    });
    if (body.length) this.send({ t: 'body', id, b64: body.toString('base64') });
    this.send({ t: 'end', id });
  }

  /** Phone live socket (the app's /ws): frames travel both ways, unframed. */
  handleSocket(ws, req) {
    const id = this.nextId++;
    const headers = collectRequestHeaders(req, WS_SKIP);

    this.streams.set(id, (kind, frame) => {
      if (kind === 'data') {
        if (ws.readyState !== 1) return;
        const bytes = Buffer.from(frame.b64 ?? '', 'base64');
        try {
          // The app's client reads JSON; a text frame must not turn into a Blob.
          ws.send(frame.text === false ? bytes : bytes.toString('utf8'));
        } catch {}
        return;
      }
      if (kind === 'close' || kind === 'error') {
        this.streams.delete(id);
        try {
          ws.close(1012, 'relay stream closed');
        } catch {}
      }
    });

    ws.on('message', (data, isBinary) => {
      this.send({ t: 'data', id, b64: data.toString('base64'), text: !isBinary });
    });
    ws.on('close', () => {
      if (this.streams.delete(id)) this.send({ t: 'close', id });
    });
    ws.on('error', () => {});

    this.send({ t: 'open', id, ws: true, path: req.url, headers });
  }

  /** Shut every stream and the desktop socket down (container stop). */
  close() {
    const agent = this.agent;
    this.agent = null;
    for (const deliver of [...this.streams.values()]) deliver('close', {});
    this.streams.clear();
    try {
      agent?.terminate();
    } catch {}
  }
}

export { AGENT_PATH, AGENT_DOWN };

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('request body too large');
      error.code = 'E_BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function collectRequestHeaders(req, skip = REQUEST_SKIP) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (skip.has(lower)) continue;
    headers[lower] = value;
  }
  return headers;
}

function sanitizeResponseHeaders(raw) {
  const headers = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (value === undefined || value === null) continue;
    const lower = name.toLowerCase();
    if (RESPONSE_SKIP.has(lower)) continue;
    headers[lower] = value;
  }
  return headers;
}

function sendText(res, status, body, headers = TEXT) {
  try {
    res.writeHead(status, headers);
    res.end(body);
  } catch {}
}