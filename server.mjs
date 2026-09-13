import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProxy } from './proxy.mjs';

export const PORT = 17863;
export const CONFIG = path.join(os.homedir(), '.codex', 'config.toml');

export function readAgentRouterToken(configPath = CONFIG) {
  const config = fs.readFileSync(configPath, 'utf8');
  const section = config.match(/^\[model_providers\.agentrouter\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  if (!section) throw new Error('AgentRouter provider is missing');
  const get = key => {
    const raw = section.match(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`, 'm'))?.[1];
    return raw?.startsWith('"') ? JSON.parse(raw) : raw?.slice(1, -1);
  };
  const value = get('experimental_bearer_token') || process.env[get('env_key')];
  if (!value || /[\r\n]/.test(value)) throw new Error('AgentRouter key is unavailable');
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const configPath = process.argv[2] || CONFIG;
    readAgentRouterToken(configPath);
    const server = createProxy({
      upstream: 'https://agentrouter.org',
      getToken: () => readAgentRouterToken(configPath),
      logger: entry => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`),
    });
    server.on('error', error => {
      process.stderr.write(`${JSON.stringify({ event: 'startup_failed', code: error.code ?? 'unknown' })}\n`);
      process.exitCode = error.code === 'EADDRINUSE' ? 0 : 1;
    });
    server.listen(PORT, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ event: 'listening', port: PORT })}\n`));
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
      server.closeAllConnections();
      server.close();
    });
  } catch {
    process.stderr.write('Proxy startup failed: verify the AgentRouter provider in .codex/config.toml.\n');
    process.exitCode = 1;
  }
}
