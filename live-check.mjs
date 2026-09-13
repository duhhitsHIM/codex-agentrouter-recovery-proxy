// Explicit, bounded live regression: sends only a synthetic prompt and the
// opaque reasoning item already rejected by this user's configured provider.
// No conversation transcript, credentials, or encrypted payloads are printed.
import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { readAgentRouterToken } from './server.mjs';

const config = process.argv[2];
const rollout = process.argv[3];
const itemId = process.argv[4];
if (!config || !rollout || !itemId) throw new Error('Usage: node live-check.mjs CONFIG ROLLOUT ITEM_ID');
const token = readAgentRouterToken(config);
let reasoning;
const lines = createInterface({ input: fs.createReadStream(rollout), crlfDelay: Infinity });
for await (const line of lines) {
  let item;
  try { item = JSON.parse(line); } catch { continue; }
  if (item.type === 'response_item' && item.payload?.id === itemId) {
    reasoning = { type: 'reasoning', summary: [], encrypted_content: item.payload.encrypted_content };
    break;
  }
}
if (!reasoning?.encrypted_content) throw new Error('Known rejected item not found');
// --corrupt forces the upstream decrypt failure on demand, so the recovery path
// stays testable once the originally rejected item is gone. The envelope prefix
// and base64 alphabet are preserved; only the ciphertext stops verifying.
if (process.argv[5] === '--corrupt') {
  const blob = reasoning.encrypted_content;
  const cut = Math.floor(blob.length / 2);
  const flipped = [...blob.slice(cut, cut + 32)].map(character => (character === 'A' ? 'B' : 'A')).join('');
  reasoning = { ...reasoning, encrypted_content: blob.slice(0, cut) + flipped + blob.slice(cut + 32) };
}
const base = 'http://127.0.0.1:17863';
const before = await (await fetch(base + '/health')).json();
const prompt = { role: 'user', content: 'Reply with exactly PROXY_OK. Do not use any tools.' };
async function run(input, label) {
  const response = await fetch(base + '/v1/responses', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'codex_cli_rs/0.154.0 (Windows; x86_64)', originator: 'codex_cli_rs' },
    body: JSON.stringify({ model: 'gpt-6-astra', instructions: 'Follow the user request exactly. This is a connection test.', input, reasoning: { effort: 'low' }, include: ['reasoning.encrypted_content'], store: false, stream: true }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  const events = text.split(/\r?\n/).filter(s => s.startsWith('data:')).map(s => { try { return JSON.parse(s.slice(5)); } catch { return null; } }).filter(Boolean);
  const completed = events.find(e => e.type === 'response.completed');
  const errors = events.filter(e => e.type === 'error' || e.type === 'response.failed');
  const reply = events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join('');
  console.log(JSON.stringify({ label, status: response.status, completed: !!completed, errors: errors.length, reply }));
  if (!response.ok || !completed || errors.length || reply.trim() !== 'PROXY_OK') {
    // Report only classifications, never raw error bodies or data.
    let errorObject;
    try { errorObject = JSON.parse(text)?.error; } catch { errorObject = errors[0]?.error ?? errors[0]?.response?.error ?? errors[0]; }
    console.log(JSON.stringify({ failure: 'live_check_failed', encryptedError: /encrypted.content[\s\S]*(?:verified|decrypt)/i.test(text), error: errorObject ? JSON.stringify(errorObject).split(token).join('<redacted>').replace(/gAAAA[A-Za-z0-9_=-]+/g, '<encrypted-content>').slice(0,800) : undefined }));
    process.exitCode = 1;
    return null;
  }
  return completed.response.output;
}
const first = await run([reasoning, prompt], 'known-rejected-reasoning');
if (first) await run([reasoning, prompt, ...first, { role: 'user', content: 'Again, reply with exactly PROXY_OK.' }], 'streaming-follow-up');
const after = await (await fetch(base + '/health')).json();
console.log(JSON.stringify({ retriesDuringTest: after.retries - before.retries, recoveredDuringTest: after.recovered - before.recovered, filteredDuringTest: after.filtered - before.filtered }));
