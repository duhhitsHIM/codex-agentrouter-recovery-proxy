import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { createProxy, isEncryptedError } from './proxy.mjs';

const TOKEN = 'test-only-secret';
const bad = { type: 'reasoning', id: 'rs_bad', summary: [], encrypted_content: 'test-opaque-content' };
const user = { role: 'user', content: 'Keep this message.' };
const tool = { type: 'function_call', call_id: 'call_1', name: 'example', arguments: '{}' };
const output = { type: 'function_call_output', call_id: 'call_1', output: 'Keep this result.' };
const compaction = { type: 'compaction', encrypted_content: 'do-not-delete-compaction' };
const err = { error: { message: 'OpenAI Responses bad request: The encrypted content for item rs_bad could not be verified. Reason: Encrypted content could not be decrypted or parsed.', type: 'invalid_request_error', code: null } };
const azure = { error: { message: 'The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it.', type: 'invalid_request_error', code: null } };
const sse = event => `data: ${JSON.stringify(event)}\n\n`;
const success = sse({ type: 'response.created', response: { id: 'resp_ok' } }) + sse({ type: 'response.output_text.delta', delta: 'OK' }) + sse({ type: 'response.completed', response: { output: [] } });

async function fixture(t, handler, options = {}) {
  const requests = [];
  const logs = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : null;
    requests.push({ body: data, headers: req.headers, url: req.url });
    await handler(req, res, data, requests.length);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const proxy = createProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, getToken: () => TOKEN, logger: x => logs.push(x), ...options });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(async () => {
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => upstream.close(r))]);
  });
  const url = `http://127.0.0.1:${proxy.address().port}`;
  const send = (payload, headers = {}, route = '/v1/responses') => fetch(url + route, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(5000),
  });
  return { send, url, requests, logs };
}

test('recognizes the real code:null error and the canonical upstream code', () => {
  assert.equal(isEncryptedError(err), true);
  assert.equal(isEncryptedError({ error: { code: 'invalid_encrypted_content' } }), true);
  assert.equal(isEncryptedError({ error: { message: 'Invalid API key' } }), false);
});

test('recognizes the Azure per-resource and org-mismatch wordings of the same failure', () => {
  assert.equal(isEncryptedError(azure), true);
  assert.equal(isEncryptedError({ error: { message: 'Encrypted content organization_id did not match the target organization.' } }), true);
  // Neither wording mentions encrypted content, so the class must be matched.
  assert.equal(isEncryptedError({ error: { message: 'The model gpt-6 does not exist or you do not have access to it.' } }), false);
  assert.equal(isEncryptedError({ error: { message: 'This resource is not available in your region.' } }), false);
});

test('an Azure-worded streamed rejection recovers like the OpenAI one', async t => {
  const f = await fixture(t, (req, res, body) => {
    if (body.input.some(item => item.encrypted_content === bad.encrypted_content)) { res.writeHead(400, { 'content-type': 'text/event-stream' }); res.end(JSON.stringify(azure)); }
    else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(success); }
  });
  assert.equal(await (await f.send({ model: 'test', input: [bad, user], stream: true })).text(), success);
  assert.deepEqual(f.requests[1].body.input, [user]);
  const health = await (await fetch(f.url + '/health')).json();
  assert.equal(health.recovered, 1);
});

test('a rejection the proxy cannot act on is logged, scrubbed, and passed through', async t => {
  const secret = 'gAAAA' + 'x'.repeat(60);
  const unknown = { error: { message: `Something new about item ${secret} we have never seen.`, type: 'invalid_request_error', code: 'brand_new_code' } };
  const f = await fixture(t, (req, res) => { res.writeHead(400, { 'content-type': 'text/event-stream' }); res.end(JSON.stringify(unknown)); });
  const response = await f.send({ model: 'test', input: [bad, user], stream: true });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), unknown);
  assert.equal(f.requests.length, 1);
  const logged = f.logs.find(entry => entry.event === 'unhandled_upstream_rejection');
  assert.equal(logged.code, 'brand_new_code');
  assert.ok(logged.message.includes('<redacted>'));
  assert.ok(!JSON.stringify(f.logs).includes(secret));
});

test('an unrecoverable bound-item error is logged as such rather than as unknown', async t => {
  // Only reasoning items are ever stripped, so a compaction-only failure is
  // recognized but deliberately left alone.
  const f = await fixture(t, (req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify(azure)); });
  assert.equal((await f.send({ model: 'test', input: [compaction, user] })).status, 400);
  assert.equal(f.requests.length, 1);
  assert.ok(f.logs.some(entry => entry.event === 'bound_item_not_recoverable'));
});

test('healthy streaming request retains encrypted reasoning and complete stream', async t => {
  const f = await fixture(t, (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(success); });
  const payload = { model: 'test', input: [bad, user, tool, output], stream: true };
  assert.equal(await (await f.send(payload)).text(), success);
  assert.deepEqual(f.requests[0].body, payload);
  assert.equal(f.requests.length, 1);
});

test('real HTTP 400 retries once, preserves messages/tools/compaction, remembers rejected blobs', async t => {
  const f = await fixture(t, (req, res, body) => {
    if (body.input.some(item => item.encrypted_content === bad.encrypted_content)) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify(err)); }
    else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(success); }
  });
  const payload = { model: 'test', reasoning: { effort: 'high' }, input: [bad, user, tool, output, compaction], stream: true };
  assert.equal(await (await f.send(payload)).text(), success);
  assert.deepEqual(f.requests[1].body, { ...payload, input: [user, tool, output, compaction] });
  assert.equal(await (await f.send(payload)).text(), success);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.requests[2].body.input, [user, tool, output, compaction]);
  const health = await (await fetch(f.url + '/health')).json();
  assert.equal(health.retries, 1); assert.equal(health.recovered, 1);
  assert.ok(!JSON.stringify(f.logs).includes(TOKEN));
  assert.ok(!JSON.stringify(f.logs).includes(bad.encrypted_content));
  assert.ok(!JSON.stringify(f.logs).includes(user.content));
});

test('a streamed 400 carrying an unframed JSON error body still retries', async t => {
  // The live gateway answers stream:true with an SSE content type but a plain
  // JSON error body, so the probe must not trust the declared framing.
  const f = await fixture(t, (req, res, body) => {
    if (body.input.some(item => item.encrypted_content === bad.encrypted_content)) { res.writeHead(400, { 'content-type': 'text/event-stream' }); res.end(JSON.stringify(err)); }
    else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(success); }
  });
  assert.equal(await (await f.send({ model: 'test', input: [bad, user], stream: true })).text(), success);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].body.input, [user]);
  const health = await (await fetch(f.url + '/health')).json();
  assert.equal(health.retries, 1);
  assert.equal(health.recovered, 1);
});

test('early SSE errors split across chunks recover without leaking the failed stream', async t => {
  const f = await fixture(t, async (req, res, body, count) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (count === 1) {
      res.write(sse({ type: 'response.created', response: { id: 'failed-first-attempt' } }));
      const frame = sse({ type: 'response.failed', response: err });
      res.write(frame.slice(0, 19));
      await new Promise(resolve => setTimeout(resolve, 10));
      res.end(frame.slice(19));
    } else res.end(success);
  });
  const text = await (await f.send({ input: [bad, user], stream: true })).text();
  assert.equal(text, success);
  assert.equal(f.requests.length, 2);
});

test('streaming starts before upstream completes', async t => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const first = sse({ type: 'response.output_text.delta', delta: 'first' });
  const f = await fixture(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(first);
    await hold; res.end(sse({ type: 'response.completed', response: {} }));
  });
  const response = await f.send({ input: [user], stream: true });
  const reader = response.body.getReader();
  const part = await reader.read();
  assert.equal(Buffer.from(part.value).toString(), first);
  release();
  while (!(await reader.read()).done) { /* drain */ }
});

test('never retries after visible model output, avoiding duplicate actions', async t => {
  const stream = sse({ type: 'response.output_text.delta', delta: 'already started' }) + sse({ type: 'error', ...err });
  const f = await fixture(t, (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(stream); });
  assert.equal(await (await f.send({ input: [bad, user], stream: true })).text(), stream);
  assert.equal(f.requests.length, 1);
});

test('second encrypted failure passes through without a retry loop', async t => {
  const f = await fixture(t, (req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify(err)); });
  const response = await f.send({ input: [bad, user] });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), err);
  assert.equal(f.requests.length, 2);
  assert.equal((await (await fetch(f.url + '/health')).json()).recovered, 0);
});

test('unrelated errors and compaction-only failures are preserved', async t => {
  const f = await fixture(t, (req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Rate limited' } })); });
  assert.equal((await f.send({ input: [bad, user] })).status, 429);
  assert.equal(f.requests.length, 1);
  const g = await fixture(t, (req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify(err)); });
  assert.equal((await g.send({ input: [compaction, user] }, {}, '/v1/responses/compact')).status, 400);
  assert.equal(g.requests.length, 1);
});

test('a retry returning a different SSE failure is not cached as recovered', async t => {
  const f = await fixture(t, (req, res, body, count) => {
    if (count % 2 === 1) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify(err)); }
    else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse({ type: 'response.failed', response: { error: { code: 'server_error', message: 'Unavailable' } } })); }
  });
  await (await f.send({ input: [bad, user] })).text();
  await (await f.send({ input: [bad, user] })).text();
  assert.equal(f.requests.length, 4);
  assert.deepEqual(f.requests[2].body.input, [bad, user]);
  assert.equal((await (await fetch(f.url + '/health')).json()).recovered, 0);
});

test('health explains a retries-vs-recovered gap without exposing upstream text', async t => {
  // The retry hits an unrelated 502, which is exactly the shape that made the
  // bare counters look like the proxy was failing when it was not.
  const f = await fixture(t, (req, res, body, count) => {
    if (count === 1) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify(err)); }
    else { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Bad gateway' } })); }
  });
  await (await f.send({ model: 'test', input: [bad, user] })).text();
  const health = await (await fetch(f.url + '/health')).json();
  assert.equal(health.retries, 1);
  assert.equal(health.recovered, 0);
  assert.match(health.note, /did not recover/);
  const failed = health.recent.find(entry => entry.event === 'encrypted_reasoning_retry_failed');
  assert.equal(failed.status, 502);
  assert.equal(failed.reason, 'upstream_failure');
  assert.ok(failed.at);
});

test('the health ring is bounded and never carries scrubbed upstream messages', async t => {
  const secret = 'gAAAA' + 'y'.repeat(60);
  const unknown = { error: { message: `Unseen wording ${secret}.`, type: 'invalid_request_error', code: 'novel_code' } };
  const f = await fixture(t, (req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify(unknown)); });
  for (let i = 0; i < 25; i++) await (await f.send({ model: 'test', input: [user] })).text();
  const health = await (await fetch(f.url + '/health')).json();
  assert.equal(health.recent.length, 20);
  // The code identifies the shape; the message itself stays in the log file only.
  assert.equal(health.recent.at(-1).event, 'unhandled_upstream_rejection');
  assert.equal(health.recent.at(-1).code, 'novel_code');
  assert.equal(health.recent.at(-1).message, undefined);
  assert.ok(!JSON.stringify(health).includes(secret));
  // The full scrubbed message still reaches the logger for the log file.
  assert.ok(f.logs.some(entry => entry.message?.includes('<redacted>')));
});

test('authentication, browser origin, host checks, route allowlist prevent unauthorized forwarding', async t => {
  const f = await fixture(t, (req, res) => res.end('{}'));
  assert.equal((await f.send({}, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await f.send({}, { origin: 'https://example.com' })).status, 403);
  // fetch normalizes Host; use the HTTP API to test an actual hostile header.
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.request(f.url + '/v1/responses', { method: 'POST', headers: { host: 'evil.example', authorization: `Bearer ${TOKEN}` } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(hostStatus, 403);
  assert.equal((await f.send({}, {}, '/v1/other')).status, 404);
  assert.equal(f.requests.length, 0);
});

test('supports gzip requests, drops cookie/hop headers, forwards session affinity headers', async t => {
  const f = await fixture(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const response = await fetch(f.url + '/v1/responses', {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-encoding': 'gzip', cookie: 'private=secret', 'session_id': 'test-session' },
    body: gzipSync(JSON.stringify({ input: [user] })),
  });
  assert.equal(response.status, 200); await response.text();
  assert.deepEqual(f.requests[0].body.input, [user]);
  assert.equal(f.requests[0].headers.cookie, undefined);
  assert.equal(f.requests[0].headers['content-encoding'], undefined);
  assert.equal(f.requests[0].headers.session_id, 'test-session');
});

test('redirects are not followed with the bearer token', async t => {
  const f = await fixture(t, (req, res) => { res.writeHead(302, { location: 'https://example.com' }); res.end(); });
  const response = await fetch(f.url + '/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{"input":[]}', redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(f.requests.length, 1);
});

test('request timeout terminates a stalled upstream', async t => {
  const f = await fixture(t, () => {}, { timeoutMs: 50 });
  const response = await f.send({ input: [user] });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'request_aborted');
});
