import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { gunzip, inflate, brotliDecompress } from 'node:zlib';

const MAX_BODY = 64 * 1024 * 1024;
const MAX_PROBE = 256 * 1024;
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-length', 'content-encoding', 'accept-encoding', 'cookie', 'set-cookie']);
const decompressors = { gzip: promisify(gunzip), deflate: promisify(inflate), br: promisify(brotliDecompress) };
const digest = value => createHash('sha256').update(value).digest('hex');
const isOpaqueReasoning = item => item?.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0;

// Every wording seen for "this item is sealed to the deployment that minted it":
// OpenAI rejects the encrypted content, Azure complains about the resource, and a
// load-balanced org mismatch reads differently again. One class, one remedy.
const BOUND_ITEM_PATTERNS = [
  /encrypted[ _]content[\s\S]*(?:could not|cannot|not be|decrypt|verif|mismatch|did not match)/i,
  /created under a different[\s\S]*?resource/i,
  /use the same resource that created the item/i,
  /organization[_ ]id did not match/i,
];

export function isEncryptedError(value) {
  const error = value?.error ?? value?.response?.error ?? value;
  if (error?.code === 'invalid_encrypted_content') return true;
  return typeof error?.message === 'string' && BOUND_ITEM_PATTERNS.some(pattern => pattern.test(error.message));
}

// Surfaces a rejection the proxy did not act on, so an unseen upstream wording
// shows up in the log instead of silently reaching the client. Opaque runs and
// anything key-shaped are scrubbed; conversation content is never read.
function describeError(chunks) {
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const error = body?.error ?? body?.response?.error ?? {};
    return {
      code: error.code ?? null,
      type: error.type ?? null,
      message: typeof error.message === 'string' ? error.message.replace(/[A-Za-z0-9_=-]{40,}/g, '<redacted>').slice(0, 200) : null,
    };
  } catch { return {}; }
}

function sameSecret(actual, expected) {
  const a = Buffer.from(actual ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function headersFor(source) {
  const headers = {};
  const entries = source instanceof Headers ? source.entries() : Object.entries(source);
  const connection = source instanceof Headers ? source.get('connection') : source.connection;
  const extraHop = new Set((connection ?? '').toLowerCase().split(',').map(s => s.trim()));
  for (const [name, value] of entries) {
    if (value !== undefined && !HOP_HEADERS.has(name.toLowerCase()) && !extraHop.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
}

async function readBody(req, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('body_limit'), { status: 413 });
    chunks.push(chunk);
  }
  let body = Buffer.concat(chunks);
  const encoding = req.headers['content-encoding'];
  if (encoding && encoding !== 'identity') {
    if (!decompressors[encoding]) throw Object.assign(new Error('unsupported_encoding'), { status: 415 });
    try { body = await decompressors[encoding](body, { maxOutputLength: limit }); }
    catch { throw Object.assign(new Error('invalid_compressed_body'), { status: 413 }); }
  }
  return body;
}

// Hold only the stream prelude, so a validation error can be retried before the
// client sees it. Once any model output is released, never replay the request.
async function probe(response) {
  const reader = response.body?.getReader();
  if (!reader) return { chunks: [], reader: null, encryptedError: false };
  const chunks = [];
  const isSse = response.headers.get('content-type')?.includes('text/event-stream');
  const inspectJson = response.status === 400 || response.status === 422 || response.headers.get('content-type')?.includes('application/json');
  if (!isSse && !inspectJson) return { chunks, reader, encryptedError: false };
  let size = 0;
  let pending = '';
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      // A gateway can answer a streaming request with an unframed JSON error
      // body under an SSE content type, so parse what actually arrived instead
      // of trusting the declared framing. Real SSE never parses as one object.
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return {
          chunks,
          reader: null,
          failed: !!body.error || body.status === 'failed',
          encryptedError: isEncryptedError(body) && (response.ok || response.status === 400 || response.status === 422),
        };
      } catch { /* Return the provider's original body. */ }
      return { chunks, reader: null, encryptedError: false };
    }
    chunks.push(Buffer.from(value));
    size += value.length;
    if (size > MAX_PROBE) return { chunks, reader, encryptedError: false };
    if (!isSse) continue;
    pending += decoder.decode(value, { stream: true });
    let separator;
    while ((separator = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, separator.index);
      pending = pending.slice(separator.index + separator[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      let event;
      try { event = JSON.parse(data); } catch { return { chunks, reader, encryptedError: false }; }
      if (isEncryptedError(event)) return { chunks, reader, encryptedError: response.ok || response.status === 400 || response.status === 422 };
      if (event.type === 'error' || event.type === 'response.failed' || event.response?.status === 'failed') return { chunks, reader, encryptedError: false, failed: true };
      if (!['response.created', 'response.in_progress', 'ping', 'heartbeat'].includes(event.type)) return { chunks, reader, encryptedError: false };
    }
  }
}

async function writeChunk(res, chunk, signal) {
  if (res.destroyed || signal.aborted) throw new Error('client_closed');
  if (!res.write(chunk)) await once(res, 'drain', { signal });
}

export function createProxy({ upstream, getToken, logger = () => {}, maxBody = MAX_BODY, timeoutMs = 600_000 }) {
  const upstreamUrl = new URL(upstream);
  if (upstreamUrl.protocol !== 'https:' && !(upstreamUrl.protocol === 'http:' && upstreamUrl.hostname === '127.0.0.1')) throw new Error('HTTPS upstream required');
  const rejected = new Set();
  const counters = { requests: 0, retries: 0, recovered: 0, filtered: 0 };
  let active = 0;
  const server = http.createServer(async (req, res) => {
    const fail = (status, code) => {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { type: 'proxy_error', code, message: code } }));
    };
    const address = server.address();
    if (req.headers.host !== `127.0.0.1:${address.port}` || req.headers.origin) { fail(403, 'local_clients_only'); return; }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ service: 'codex-agentrouter-recovery-proxy', version: '1.0.0', ...counters }));
      return;
    }
    let token;
    try { token = getToken(); } catch { fail(503, 'provider_key_unavailable'); return; }
    if (!token || !sameSecret(req.headers.authorization, `Bearer ${token}`)) { fail(401, 'unauthorized'); return; }
    const route = req.url?.split('?')[0];
    if (!((req.method === 'POST' && ['/v1/responses', '/v1/responses/compact'].includes(route)) || (req.method === 'GET' && route === '/v1/models'))) { fail(404, 'unsupported_route'); return; }
    if (active >= 8) { fail(503, 'proxy_busy'); return; }
    active++;
    counters.requests++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    req.once('aborted', () => controller.abort());
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    let currentProbe;
    try {
      let body = req.method === 'POST' ? await readBody(req, maxBody) : undefined;
      let payload;
      if (body) {
        try { payload = JSON.parse(body.toString('utf8')); }
        catch { fail(400, 'invalid_json'); return; }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { fail(400, 'invalid_json_object'); return; }
      }
      if (Array.isArray(payload?.input)) {
        const input = payload.input.filter(item => !isOpaqueReasoning(item) || !rejected.has(digest(item.encrypted_content)));
        if (input.length !== payload.input.length) {
          counters.filtered += payload.input.length - input.length;
          payload = { ...payload, input };
          body = Buffer.from(JSON.stringify(payload));
        }
      }
      const headers = headersFor(req.headers);
      headers.authorization = `Bearer ${token}`;
      headers['accept-encoding'] = 'identity';
      const destination = new URL(req.url, upstreamUrl.origin);
      const send = () => fetch(destination, { method: req.method, headers, body, signal: controller.signal, redirect: 'manual' });
      let response = await send();
      currentProbe = await probe(response);
      const candidates = Array.isArray(payload?.input) ? payload.input.filter(isOpaqueReasoning) : [];
      if (currentProbe.encryptedError && candidates.length) {
        await currentProbe.reader?.cancel();
        payload = { ...payload, input: payload.input.filter(item => !isOpaqueReasoning(item)) };
        body = Buffer.from(JSON.stringify(payload));
        counters.retries++;
        logger({ event: 'encrypted_reasoning_retry', removed: candidates.length });
        response = await send();
        currentProbe = await probe(response);
        if (response.ok && !currentProbe.encryptedError && !currentProbe.failed) {
          counters.recovered++;
          for (const item of candidates) {
            rejected.add(digest(item.encrypted_content));
            if (rejected.size > 4096) rejected.delete(rejected.values().next().value);
          }
          logger({ event: 'encrypted_reasoning_recovered', removed: candidates.length });
        }
      } else if ([400, 422].includes(response.status)) {
        logger({
          event: currentProbe.encryptedError ? 'bound_item_not_recoverable' : 'unhandled_upstream_rejection',
          status: response.status,
          ...describeError(currentProbe.chunks),
        });
      }
      res.writeHead(response.status, headersFor(response.headers));
      for (const chunk of currentProbe.chunks) await writeChunk(res, chunk, controller.signal);
      if (currentProbe.reader) {
        while (true) {
          const { done, value } = await currentProbe.reader.read();
          if (done) break;
          await writeChunk(res, value, controller.signal);
        }
      }
      res.end();
    } catch (error) {
      logger({ event: controller.signal.aborted ? 'request_aborted' : 'request_failed', status: error.status ?? 502 });
      fail(error.status ?? 502, controller.signal.aborted ? 'request_aborted' : (error.status ? error.message : 'upstream_connection_failed'));
    } finally {
      controller.abort();
      await currentProbe?.reader?.cancel().catch(() => {});
      clearTimeout(timer);
      active--;
    }
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5000;
  return server;
}
