import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
export const isCompaction = item => item?.type === 'compaction' && typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0;
export const isCompactionRequest = payload => Array.isArray(payload?.input) && payload.input.some(item => item?.type === 'compaction_trigger');
const keyOf = item => hash(item.encrypted_content);
const problem = code => Object.assign(new Error(code), { code });

// Collect only a completed compaction result. Never execute output from a replay.
export class CompactionResult {
  constructor(limit = 8 * 1024 * 1024) {
    this.limit = limit;
    this.decoder = new TextDecoder();
    this.pending = '';
    this.items = new Map();
    this.completed = false;
    this.failed = false;
  }

  event(event) {
    if (event.type === 'error' || event.type === 'response.failed' || event.response?.status === 'failed') this.failed = true;
    if (event.type === 'response.output_item.done') this.item(event.item);
    if (event.type === 'response.output_item.added' && event.item?.type !== 'compaction') this.failed = true;
    if (event.type === 'response.output_text.delta') this.failed = true;
    if (event.type === 'response.completed') {
      this.completed = true;
      for (const item of event.response?.output ?? []) this.item(item);
    }
  }

  item(item) {
    if (!isCompaction(item)) { this.failed = true; return; }
    this.items.set(keyOf(item), item);
    if (this.items.size > 1) this.failed = true;
  }

  push(chunk) {
    if (this.failed) return;
    this.pending += this.decoder.decode(chunk, { stream: true });
    if (this.pending.length > this.limit) { this.failed = true; return; }
    let separator;
    while ((separator = /\r?\n\r?\n/.exec(this.pending))) {
      const frame = this.pending.slice(0, separator.index);
      this.pending = this.pending.slice(separator.index + separator[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { this.event(JSON.parse(data)); } catch { this.failed = true; }
    }
  }

  finish() {
    this.pending += this.decoder.decode();
    if (this.pending.trim()) {
      try {
        const body = JSON.parse(this.pending);
        if (body.status !== 'completed' || !Array.isArray(body.output)) this.failed = true;
        else { this.completed = true; for (const item of body.output) this.item(item); }
      } catch { this.failed = true; }
    }
    return this.result();
  }

  result() { return !this.failed && this.completed && this.items.size === 1 ? this.items.values().next().value : null; }
}

// Opt-in private state: full checkpoint bodies are needed to retain tools/media.
// Authorization headers and endpoint addresses are never part of this store.
export class FileCompactionStore {
  constructor(directory) { this.directory = path.resolve(directory); }

  async directoryFor(...parts) {
    const directory = path.join(this.directory, ...parts);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw problem('checkpoint_store_unavailable');
    return directory;
  }

  async write(parts, name, value) {
    const directory = await this.directoryFor();
    const targetDirectory = parts.length ? await this.directoryFor(...parts) : directory;
    const temporary = path.join(targetDirectory, '.' + randomUUID() + '.tmp');
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, path.join(targetDirectory, name + '.json'));
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async read(parts, name) {
    try {
      const stat = await fs.lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw problem('checkpoint_store_unavailable');
      return JSON.parse(await fs.readFile(path.join(this.directory, ...parts, name + '.json'), 'utf8'));
    }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw problem('checkpoint_store_unavailable');
    }
  }

  async remember(item, payload) {
    if (!isCompaction(item) || !isCompactionRequest(payload)) throw problem('unsupported_compaction');
    await this.write(['checkpoints'], keyOf(item), { version: 1, item, payload });
  }

  async checkpoint(key) {
    const value = await this.read(['checkpoints'], key);
    if (!value) throw problem('checkpoint_missing');
    if (value.version !== 1 || !isCompaction(value.item) || keyOf(value.item) !== key || !isCompactionRequest(value.payload)) throw problem('checkpoint_corrupt');
    return value.payload;
  }

  async mapped(scope, key) {
    const item = await this.read(['mappings', scope], key);
    if (item && !isCompaction(item)) throw problem('checkpoint_corrupt');
    return item;
  }

  async map(scope, key, item) { await this.write(['mappings', scope], key, item); }
  async invalidate(scope) { await fs.rm(path.join(this.directory, 'mappings', scope), { recursive: true, force: true }); }
}

export class CompactionRecovery {
  constructor(store, { maxCheckpoints = 64 } = {}) {
    this.store = store;
    this.maxCheckpoints = maxCheckpoints;
    this.locks = new Map();
  }

  // Both endpoint and credential identity matter. Persist only their digest.
  scope(upstream, token) { return hash(JSON.stringify([upstream, token])); }

  async replaceKnown(payload, scope) {
    if (!Array.isArray(payload?.input)) return payload;
    const input = [];
    for (const item of payload.input) input.push(isCompaction(item) ? (await this.store.mapped(scope, keyOf(item)) ?? item) : item);
    return { ...payload, input };
  }

  async recover(payload, scope, rejectedItems, rebuild, signal) {
    const previous = this.locks.get(scope) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      const rejected = new Set(rejectedItems.filter(isCompaction).map(keyOf));
      // A cached target can itself become invalid after backend rotation. Another
      // concurrent recovery may already have replaced it; do not erase that work.
      for (const item of payload.input.filter(isCompaction)) {
        const cached = await this.store.mapped(scope, keyOf(item));
        if (cached && rejected.has(keyOf(cached))) { await this.store.invalidate(scope); break; }
      }
      let count = 0;
      let usedCache = false;
      const rebuildChain = async () => {
        const resolved = new Map();
        const visiting = new Set();
        const resolve = async item => {
          signal?.throwIfAborted();
          const key = keyOf(item);
          if (resolved.has(key)) return resolved.get(key);
          if (visiting.has(key)) throw problem('checkpoint_cycle');
          const cached = await this.store.mapped(scope, key);
          if (cached) { usedCache = true; resolved.set(key, cached); return cached; }
          if (++count > this.maxCheckpoints) throw problem('checkpoint_limit');
          visiting.add(key);
          const original = await this.store.checkpoint(key);
          const input = [];
          for (const entry of original.input) input.push(isCompaction(entry) ? await resolve(entry) : entry);
          const request = { ...original, input };
          const rebuilt = await rebuild(request);
          if (!isCompaction(rebuilt?.item)) throw problem('compaction_replay_failed');
          // Keep the target checkpoint too, so a later switch can rebuild its chain.
          await this.store.remember(rebuilt.item, rebuilt.payload ?? request);
          await this.store.map(scope, key, rebuilt.item);
          visiting.delete(key);
          resolved.set(key, rebuilt.item);
          return rebuilt.item;
        };
        const input = [];
        for (const item of payload.input) input.push(isCompaction(item) ? await resolve(item) : item);
        return { ...payload, input };
      };
      try { return await rebuildChain(); }
      catch (error) {
        // A dependency can be cached even when the latest checkpoint is new.
        // Discard that stale target chain once, within the same request budget.
        if (error.code !== 'checkpoint_target_rejected' || !usedCache) throw error;
        await this.store.invalidate(scope);
        return await rebuildChain();
      }
    });
    this.locks.set(scope, task);
    try { return await task; }
    finally { if (this.locks.get(scope) === task) this.locks.delete(scope); }
  }
}
