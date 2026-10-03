#!/usr/bin/env node
/**
 * Build ONE reviewed tgz of @agent-jake-browser/protocol from the exact source and write provenance.json.
 *   node tools/pack.mjs <outDir>      (default: ./artifact)
 * Generated metadata: package.json#browserHarnessProtocol {supportedProtocolVersions, catalogVersion}.
 * Publishing to a registry is out of scope.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifierSha256 } from './verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const repoRoot = resolve(pkgDir, '../..');
const outDir = resolve(process.argv[2] ?? join(pkgDir, 'artifact'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();

execFileSync('npx', ['tsup'], { cwd: pkgDir, stdio: 'inherit' });
const mod = await import(`${pathToFileURL(join(pkgDir, 'dist/index.js')).href}?v=${Date.now()}`);
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

const stage = mkdtempSync(join(tmpdir(), 'ajb-pack-'));
cpSync(join(pkgDir, 'dist'), join(stage, 'dist'), { recursive: true });
const staged = { ...pkg, scripts: undefined, dependencies: undefined, devDependencies: undefined };
staged.browserHarnessProtocol = {
  supportedProtocolVersions: [...mod.SUPPORTED_PROTOCOL_VERSIONS],
  catalogVersion: mod.CATALOG_VERSION,
};
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`);

mkdirSync(outDir, { recursive: true });
const tgzName = run('npm', ['pack', '--silent', '--pack-destination', outDir], stage).split('\n').pop();
const tgzPath = join(outDir, tgzName);
const wanted = join(outDir, 'agent-jake-browser-protocol.tgz');
if (existsSync(wanted)) rmSync(wanted);
renameSync(tgzPath, wanted);

const lock = join(repoRoot, 'package-lock.json');
let sourceSha = 'unknown';
try { sourceSha = run('git', ['rev-parse', 'HEAD'], repoRoot); } catch { /* not a git checkout */ }
const provenance = {
  package: pkg.name,
  version: pkg.version,
  sourceRepo: 'pocharlies-org/agent-jake-browser-mcp-server',
  sourceSha,
  sourceLockfileSha256: existsSync(lock) ? sha(readFileSync(lock)) : null,
  toolchain: {
    node: process.version,
    npm: run('npm', ['--version'], pkgDir),
    tsup: JSON.parse(readFileSync(join(repoRoot, 'node_modules/tsup/package.json'), 'utf8')).version,
    typescript: JSON.parse(readFileSync(join(repoRoot, 'node_modules/typescript/package.json'), 'utf8')).version,
  },
  supportedProtocolVersions: [...mod.SUPPORTED_PROTOCOL_VERSIONS],
  catalogVersion: mod.CATALOG_VERSION,
  tgzSha256: sha(readFileSync(wanted)),
  verifierSha256: verifierSha256(),
};
writeFileSync(join(outDir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
rmSync(stage, { recursive: true, force: true });
console.log(`packed ${wanted}\n${JSON.stringify(provenance, null, 2)}`);
