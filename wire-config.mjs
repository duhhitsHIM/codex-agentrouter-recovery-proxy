// Points Codex at the local recovery proxy, and back again with --undo.
// Editing config.toml by hand is the step everyone forgets, and a proxy that is
// never wired in looks exactly like a proxy that does not work.
//   node wire-config.mjs [--undo] [path/to/config.toml]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PORT } from './server.mjs';

const UPSTREAM = 'https://agentrouter.org/v1';
const PROXY = `http://127.0.0.1:${PORT}/v1`;
const args = process.argv.slice(2);
const undo = args.includes('--undo');
const configPath = args.find(arg => !arg.startsWith('--')) ?? path.join(os.homedir(), '.codex', 'config.toml');

const report = (status, detail = {}) => console.log(JSON.stringify({ status, ...detail }));
if (!fs.existsSync(configPath)) { report('missing_config', { configPath }); process.exit(1); }

const config = fs.readFileSync(configPath, 'utf8');
const section = /^\[model_providers\.agentrouter\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(config);
if (!section) {
  // server.mjs reads the token from this exact section name, so a differently
  // named provider would start cleanly and then fail on every request.
  const named = [...config.matchAll(/^\[model_providers\.([^\]]+)\]/gm)].map(match => match[1]);
  report('no_agentrouter_provider', { configPath, providersFound: named });
  process.exit(1);
}

const line = /^(\s*base_url\s*=\s*)("[^"]*"|'[^']*')(.*)$/m.exec(section[1]);
if (!line) { report('no_base_url', { configPath }); process.exit(1); }
const current = line[2].slice(1, -1);
// The original endpoint is parked in the trailing comment, so --undo restores the
// provider the user actually had instead of a hardcoded guess.
const parked = /->\s*(\S+)/.exec(line[3])?.[1];
const origin = current.startsWith(`http://127.0.0.1:${PORT}`) ? (parked ?? UPSTREAM) : current;
const target = undo ? (parked ?? UPSTREAM) : PROXY;
const nextLine = `${line[1]}"${target}"${undo ? '' : ` # local recovery proxy -> ${origin}`}`;
if (nextLine === line[0]) { report('already_set', { base_url: target }); process.exit(0); }

const backup = `${configPath}.bak-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`;
fs.copyFileSync(configPath, backup);
// Splice by offset: a URL containing $ would be mangled by String.replace patterns.
const start = section.index + (section[0].length - section[1].length) + section[1].indexOf(line[0]);
fs.writeFileSync(configPath, config.slice(0, start) + nextLine + config.slice(start + line[0].length));
report(undo ? 'restored' : 'wired', { base_url: target, was: current, backup });
