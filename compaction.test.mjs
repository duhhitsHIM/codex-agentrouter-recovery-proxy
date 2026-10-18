import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createProxy } from './proxy.mjs';
import { CompactionResult, CompactionRecovery, FileCompactionStore } from './compaction.mjs';

const compact = (account, stage) => ({ type: 'compaction', id: `cmp_${account}_${stage}`, encrypted_content: `fixture-compaction-${account}-${stage}` });
const rejection = { error: { code: 'invalid_encrypted_content', message: 'Fixture encrypted content could not be verified.' } };
const sse = event => `data: ${JSON.stringify(event)}\n\n`;
const completed = item => sse({ type: 'response.output_item.done', item }) + sse({ type: 'response.completed', response: { status: 'completed', output: [item] } });
const success = sse({ type: 'response.output_text.delta', delta: 'continued' }) + sse({ type: 'response.completed', response: { status: 'completed', output: [] } });
const opaqueReasoning = { type: 'reasoning', encrypted_content: 'fixture-source-reasoning' };
const stageItems = stage => [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: `stage ${stage}` }, { type: 'input_image', image_url: 'data:image/png;base64,Zml4dHVyZQ==' }, { type: 'input_audio', input_audio: { data: 'Zml4dHVyZQ==', format: 'wav' } }] },
  { type: 'custom_tool_call', call_id: `call_${stage}`, name: 'fixture', input: '{}' },
  { type: 'custom_tool_call_output', call_id: `call_${stage}`, output: `saved output ${stage}; worker limit=13` },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `fixture alias ${stage}` }] },
];
const checkpoint = (stage, previous) => ({ model: 'fixture-model', stream: true, store: false, input: [...(previous ? [previous] : []), ...stageItems(stage), opaqueReasoning, { type: 'compaction_trigger' }] });

async function directory(t) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'compaction-test-'));
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}

async function fixture(t, options = {}) {
  const state = options.directory ?? await directory(t);
  const requests = [];
  const logs = [];
  let account = 'A';
  let rejectReplay = false;
  let visible = false;
  let generation = '';
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const target = req.headers.authorization.slice('Bearer fixture-'.length);
    requests.push({ body, account: target });
    const isReplay = body.input.some(item => item.type === 'compaction_trigger');
    if (visible) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse({ type: 'response.output_text.delta', delta: 'already visible' }) + sse({ type: 'error', ...rejection })); return; }
    const foreign = body.input.some(item => item.type === 'compaction' && !item.id.startsWith(`cmp_${target}${generation}_`));
    if (foreign || (target !== 'A' && body.input.includes(opaqueReasoning)) || (target !== 'A' && body.input.some(item => item.encrypted_content === opaqueReasoning.encrypted_content))) {
      // Intentionally missing Content-Type, matching a real Responses gateway.
      res.writeHead(options.sseError ? 200 : 400);
      res.end(options.sseError ? sse({ type: 'response.failed', response: rejection }) : JSON.stringify(rejection));
      return;
    }
    if (isReplay && rejectReplay) { res.writeHead(503); res.end(JSON.stringify({ error: { code: 'fixture_unavailable' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!isReplay) { res.end(success); return; }
    const stage = Number(body.input.findLast(item => item.role === 'user').content[0].text.split(' ')[1]);
    if (options.outputAction && target !== 'A') {
      res.end(completed({ type: 'custom_tool_call', call_id: 'never_execute', name: 'fixture', input: '{}' }));
    } else res.end(completed(compact(target + generation, stage)));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxies = [];
  async function start() {
    const proxy = createProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, getToken: () => 'fixture-' + account, logger: entry => logs.push(entry), compactionStore: options.store ?? new FileCompactionStore(state) });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening'); proxies.push(proxy);
    return proxy;
  }
  let proxy = await start();
  t.after(async () => {
    for (const server of [...proxies, upstream]) server.closeAllConnections();
    await Promise.all([...proxies, upstream].map(server => server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve()));
  });
  const open = body => fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer fixture-' + account, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  return {
    state, requests, logs, open,
    account(value) { account = value; },
    failReplay(value = true) { rejectReplay = value; },
    visible(value = true) { visible = value; },
    rotate(value) { generation = value; },
    async restart() { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); proxy = await start(); },
    async send(body) {
      const response = await open(body);
      return { status: response.status, text: await response.text() };
    },
  };
}

async function seed(f) {
  for (let stage = 1; stage <= 3; stage++) {
    const response = await f.send(checkpoint(stage, stage > 1 ? compact('A', stage - 1) : null));
    assert.equal(response.status, 200);
  }
}

test('three checkpoints rebuild in order, preserving tools/media and final request', async t => {
  const f = await fixture(t); await seed(f); f.account('B');
  const input = [compact('A', 3), ...stageItems(4)];
  const response = await f.send({ model: 'fixture-model', stream: true, metadata: { fixture: 'original thread' }, input });
  assert.equal(response.text, success);
  const rebuilt = f.requests.filter(r => r.account === 'B' && r.body.input.some(i => i.type === 'compaction_trigger') && !r.body.input.some(i => i.type === 'reasoning'));
  assert.equal(rebuilt.length, 3);
  for (let index = 0; index < 3; index++) {
    const expected = checkpoint(index + 1, index ? compact('B', index) : null);
    expected.input = expected.input.filter(item => item.type !== 'reasoning');
    assert.deepEqual(rebuilt[index].body, expected);
  }
  assert.deepEqual(f.requests.at(-1).body, { model: 'fixture-model', stream: true, metadata: { fixture: 'original thread' }, input: [compact('B', 3), ...stageItems(4)] });
  assert.equal(f.logs.filter(entry => entry.event === 'compaction_checkpoint_rebuilt').length, 3);
  assert.ok(!JSON.stringify(f.logs).includes('saved output'));
  assert.ok(!JSON.stringify(f.logs).includes('fixture-compaction'));
  assert.ok(!JSON.stringify(f.logs).includes('fixture-B'));
});

test('persistent mappings survive restart and a different credential gets its own chain', async t => {
  const f = await fixture(t); await seed(f); f.account('B');
  const question = { input: [compact('A', 3), ...stageItems(4)], stream: true };
  assert.equal((await f.send(question)).text, success);
  await f.restart();
  const before = f.requests.length;
  assert.equal((await f.send(question)).text, success);
  assert.equal(f.requests.length, before + 1);
  f.account('C');
  assert.equal((await f.send(question)).text, success);
  assert.equal(f.requests.at(-1).body.input[0].id, 'cmp_C_3');
  const files = await fs.readdir(path.join(f.state, 'mappings'));
  assert.equal(files.length, 2);
  assert.ok(files.every(value => /^[a-f0-9]{64}$/.test(value)));
});

test('missing checkpoints and replay failures preserve the rejection without deletion', async t => {
  const f = await fixture(t); f.account('B');
  const payload = { input: [compact('A', 3), ...stageItems(4)] };
  const response = await f.send(payload);
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.text), rejection);
  assert.equal(f.requests.length, 1);
  f.account('A'); await seed(f); f.account('B'); f.failReplay();
  const failed = await f.send(payload);
  assert.equal(failed.status, 400);
  assert.deepEqual(JSON.parse(failed.text), rejection);
  assert.ok(f.requests.every(r => r.body.input.some(i => i.type === 'compaction') || r.body.input.some(i => i.type === 'compaction_trigger')));
});

test('HTTP 200 SSE rejection without Content-Type can rebuild compaction', async t => {
  const f = await fixture(t, { sseError: true }); await seed(f); f.account('B');
  assert.equal((await f.send({ input: [compact('A', 3)], stream: true })).text, success);
});

test('visible output is never retried, even with available checkpoints', async t => {
  const f = await fixture(t); await seed(f); f.account('B'); f.visible();
  const before = f.requests.length;
  const response = await f.send({ input: [compact('A', 3)], stream: true });
  assert.ok(response.text.includes('already visible'));
  assert.equal(f.requests.length, before + 1);
});

test('tool requests returned by a replay are not accepted or exposed as recovery', async t => {
  const f = await fixture(t, { outputAction: true }); await seed(f); f.account('B');
  const response = await f.send({ input: [compact('A', 3)], stream: true });
  assert.equal(response.status, 400);
  assert.ok(!response.text.includes('never_execute'));
});

test('same-credential backend rotation invalidates stale mappings', async t => {
  const f = await fixture(t); await seed(f); f.account('B');
  const payload = { input: [compact('A', 3)], stream: true };
  assert.equal((await f.send(payload)).text, success);
  f.rotate('new');
  assert.equal((await f.send(payload)).text, success);
  assert.equal(f.requests.at(-1).body.input[0].id, 'cmp_Bnew_3');
});

test('rotation also rebuilds a stale cached dependency of a new checkpoint', async t => {
  const f = await fixture(t); await seed(f); f.account('B');
  assert.equal((await f.send({ input: [compact('A', 3)] })).text, success);
  f.account('A');
  assert.equal((await f.send(checkpoint(4, compact('A', 3)))).status, 200);
  f.account('B'); f.rotate('new');
  assert.equal((await f.send({ input: [compact('A', 4)] })).text, success);
  assert.equal(f.requests.at(-1).body.input[0].id, 'cmp_Bnew_4');
});

test('a later switch can rebuild a checkpoint minted during an earlier recovery', async t => {
  const f = await fixture(t); await seed(f); f.account('B');
  assert.equal((await f.send({ input: [compact('A', 3)] })).text, success);
  f.account('C');
  assert.equal((await f.send({ input: [compact('B', 3)] })).text, success);
  assert.equal(f.requests.at(-1).body.input[0].id, 'cmp_C_3');
});

test('state files contain no authorization headers and use private POSIX permissions', async t => {
  const f = await fixture(t); await seed(f);
  const root = await fs.stat(f.state);
  if (process.platform !== 'win32') assert.equal(root.mode & 0o777, 0o700);
  const folder = path.join(f.state, 'checkpoints');
  for (const name of await fs.readdir(folder)) {
    const raw = await fs.readFile(path.join(folder, name), 'utf8');
    assert.ok(!raw.includes('Bearer'));
    assert.ok(!raw.includes('authorization'));
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(folder, name))).mode & 0o777, 0o600);
  }
});

test('an existing public state directory is rejected without changing its permissions', { skip: process.platform === 'win32' }, async t => {
  const root = await directory(t); const state = path.join(root, 'public-state');
  await fs.mkdir(state, { mode: 0o755 }); await fs.chmod(state, 0o755);
  const store = new FileCompactionStore(state);
  await assert.rejects(store.remember(compact('A', 1), checkpoint(1)), /checkpoint_store_unavailable/);
  assert.equal((await fs.stat(state)).mode & 0o777, 0o755);
  assert.deepEqual(await fs.readdir(state), []);
});

test('cycles, checkpoint limits and cancellation stop before a model request', async t => {
  const state = await directory(t); const store = new FileCompactionStore(state);
  const self = compact('A', 1); await store.remember(self, checkpoint(1, self));
  const recovery = new CompactionRecovery(store);
  let calls = 0; const rebuild = () => { calls++; throw new Error('must not run'); };
  await assert.rejects(recovery.recover({ input: [self] }, 'fixture', [self], rebuild), /checkpoint_cycle/);
  const limited = new CompactionRecovery(store, { maxCheckpoints: 0 });
  await assert.rejects(limited.recover({ input: [self] }, 'fixture', [self], rebuild), /checkpoint_limit/);
  await assert.rejects(recovery.recover({ input: [self] }, 'fixture', [self], rebuild, AbortSignal.abort()), /abort/i);
  assert.equal(calls, 0);
});

test('collector requires a complete, single compaction result and rejects truncated/action streams', () => {
  const good = new CompactionResult();
  for (const byte of Buffer.from(completed(compact('A', 1)))) good.push(Buffer.from([byte]));
  assert.deepEqual(good.finish(), compact('A', 1));
  for (const stream of [sse({ type: 'response.output_item.done', item: compact('A', 1) }), completed({ type: 'function_call', name: 'fixture' }), completed(compact('A', 1)) + sse({ type: 'response.failed' })]) {
    const collector = new CompactionResult(); collector.push(Buffer.from(stream)); assert.equal(collector.finish(), null);
  }
});

test('concurrent recoveries share persisted checkpoint results', async t => {
  const state = await directory(t); const store = new FileCompactionStore(state);
  await store.remember(compact('A', 1), checkpoint(1));
  const recovery = new CompactionRecovery(store); let calls = 0;
  const rebuild = async payload => { calls++; return { item: compact('B', 1), payload }; };
  const payload = { input: [compact('A', 1)] };
  await Promise.all([1, 2].map(() => recovery.recover(payload, 'fixture', payload.input, rebuild)));
  assert.equal(calls, 1);
});

test('a damaged checkpoint cannot silently become a successful empty recovery', async t => {
  const state = await directory(t); const store = new FileCompactionStore(state);
  const item = compact('A', 1); await store.remember(item, checkpoint(1));
  const key = createHash('sha256').update(item.encrypted_content).digest('hex');
  await fs.writeFile(path.join(state, 'checkpoints', key + '.json'), JSON.stringify({ version: 99, item, payload: {} }));
  await assert.rejects(new CompactionRecovery(store).recover({ input: [item] }, 'fixture', [item], () => assert.fail('must not replay')), /checkpoint_corrupt/);
});

test('checkpoint is persisted before its completed event reaches the client', async t => {
  const state = await directory(t); const store = new FileCompactionStore(state);
  const remember = store.remember.bind(store);
  let started, release;
  const writing = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  store.remember = async (...args) => { started(); await hold; await remember(...args); };
  const f = await fixture(t, { directory: state, store });
  let received = false;
  const pending = f.open(checkpoint(1)).then(response => { received = true; return response; });
  await writing;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(received, false);
  release();
  await (await pending).text();
  assert.ok(await store.checkpoint(createHash('sha256').update(compact('A', 1).encrypted_content).digest('hex')));
});
