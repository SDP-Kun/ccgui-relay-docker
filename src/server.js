import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { Relay, AGENT_PATH, AGENT_DOWN } from './relay.js';

const STATUS_TEXT = {
  400: 'Bad Request',
  403: 'Forbidden',
  426: 'Upgrade Required',
  503: 'Service Unavailable',
};

export function createRelayServer({
  relayKey,
  headTimeoutMs = 30_000,
  maxBodyBytes = 64 * 1024 * 1024,
  pingIntervalMs = 30_000,
  log = (...args) => console.error('[relay]', ...args),
} = {}) {
  if (!relayKey) throw new Error('relayKey is required');

  const relay = new Relay({ headTimeoutMs, maxBodyBytes, log });
  const wss = new WebSocketServer({ noServer: true });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://relay.invalid');

    if (url.pathname === '/healthz') {
      const body = JSON.stringify({ ok: true, agent: relay.hasAgent() });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    // The desktop path exists only as a WebSocket; a plain GET explains that.
    if (url.pathname === AGENT_PATH) {
      res.writeHead(426, { ...TEXT, upgrade: 'websocket' });
      res.end('expected a websocket');
      return;
    }

    relay.handleHttp(req, res).catch((error) => {
      log('request failed:', error?.message ?? error);
      if (!res.headersSent) {
        res.writeHead(500, TEXT);
        res.end('relay internal error');
      } else {
        res.destroy();
      }
    });
  });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://relay.invalid');
    } catch {
      return rejectUpgrade(socket, 400, 'bad request');
    }

    if (url.pathname === AGENT_PATH) {
      if (!keyMatches(url.searchParams.get('key'), relayKey)) {
        return rejectUpgrade(socket, 403, 'forbidden');
      }
      wss.handleUpgrade(req, socket, head, (ws) => relay.attachAgent(ws));
      return;
    }

    if (!relay.hasAgent()) return rejectUpgrade(socket, 503, AGENT_DOWN);
    wss.handleUpgrade(req, socket, head, (ws) => relay.handleSocket(ws, req));
  });

  // A desktop behind NAT can vanish without a close frame; ping it so the
  // relay stops advertising a dead agent and fails phone requests quickly.
  const heartbeat =
    pingIntervalMs > 0
      ? setInterval(() => {
          const agent = relay.agent;
          if (!agent) return;
          if (agent.isAlive === false) {
            agent.terminate();
            return;
          }
          agent.isAlive = false;
          try {
            agent.ping();
          } catch {}
        }, pingIntervalMs)
      : null;
  heartbeat?.unref?.();

  return {
    server,
    relay,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve(server.address().port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    async close() {
      if (heartbeat) clearInterval(heartbeat);
      relay.close();
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {}
      }
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

const TEXT = { 'content-type': 'text/plain; charset=utf-8' };

function keyMatches(supplied, expected) {
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function rejectUpgrade(socket, status, message) {
  const body = Buffer.from(message);
  const head =
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${body.length}\r\n\r\n`;
  try {
    socket.end(Buffer.concat([Buffer.from(head), body]));
  } catch {
    socket.destroy();
  }
}

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return Math.floor(value);
}

async function main() {
  const relayKey = process.env.RELAY_KEY;
  if (!relayKey) {
    console.error('[relay] RELAY_KEY is required. Set it to the same value as the relay key in CC GUI.');
    process.exit(1);
  }
  if (relayKey.length < 16) {
    console.warn('[relay] RELAY_KEY is shorter than 16 characters; use a long random value.');
  }

  const port = intFromEnv('PORT', 8787);
  const host = process.env.HOST || '0.0.0.0';
  const app = createRelayServer({
    relayKey,
    headTimeoutMs: intFromEnv('HEAD_TIMEOUT_MS', 30_000),
    maxBodyBytes: intFromEnv('MAX_BODY_BYTES', 64 * 1024 * 1024),
    pingIntervalMs: intFromEnv('AGENT_PING_INTERVAL_MS', 30_000),
  });

  const bound = await app.listen(port, host);
  console.log(`[relay] listening on ${host}:${bound} (agent path ${AGENT_PATH}, health /healthz)`);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[relay] ${signal} received, shutting down`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().catch((error) => {
    console.error('[relay] failed to start:', error?.message ?? error);
    process.exit(1);
  });
}