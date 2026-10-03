import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM tool without types
import { verifyArtifact } from '../tools/verify.mjs';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
let work: string;
let good: { tgz: string; provenance: string };

/** Unpack the good tgz, let `mutate` edit it, repack, and (optionally) keep provenance consistent with the new bytes. */
function tampered(name: string, mutate: (root: string) => void, rehash = true) {
  const dir = join(work, name);
  execFileSync('mkdir', ['-p', dir]);
  execFileSync('tar', ['-xzf', good.tgz, '-C', dir]);
  mutate(join(dir, 'package'));
  const tgz = join(dir, 'out.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', dir, 'package']);
  const prov = JSON.parse(readFileSync(good.provenance, 'utf8'));
  if (rehash) prov.tgzSha256 = sha(readFileSync(tgz));
  const provenance = join(dir, 'provenance.json');
  writeFileSync(provenance, JSON.stringify(prov));
  return { tgz, provenance };
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'ajb-artifact-test-'));
  execFileSync('node', ['tools/pack.mjs', join(work, 'good')], { cwd: pkgDir, stdio: 'pipe' });
  good = { tgz: join(work, 'good/agent-jake-browser-protocol.tgz'), provenance: join(work, 'good/provenance.json') };
}, 120_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('vendored artifact verification (offline)', () => {
  it('passes for the packed artifact', async () => {
    expect(await verifyArtifact(good)).toEqual({ ok: true, errors: [] });
  });
  it('packs generated browserHarnessProtocol metadata', () => {
    const dir = join(work, 'meta');
    execFileSync('mkdir', ['-p', dir]);
    execFileSync('tar', ['-xzf', good.tgz, '-C', dir]);
    const pkg = JSON.parse(readFileSync(join(dir, 'package/package.json'), 'utf8'));
    expect(pkg.browserHarnessProtocol.supportedProtocolVersions).toEqual([1]);
    expect(pkg.browserHarnessProtocol.catalogVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('fails when descriptors are manipulated (hash consistent, digest not)', async () => {
    const t = tampered('descriptors', (root) => {
      const f = join(root, 'dist/index.js');
      writeFileSync(f, readFileSync(f, 'utf8').replace(/"browser_click"|'browser_click'/, '"browser_clack"'));
    });
    const r = await verifyArtifact(t);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/differs from packed descriptors/);
  });
  it('fails with a stale manifest', async () => {
    const t = tampered('manifest', (root) => {
      const f = join(root, 'package.json');
      const pkg = JSON.parse(readFileSync(f, 'utf8'));
      pkg.browserHarnessProtocol.catalogVersion = `sha256:${'0'.repeat(64)}`;
      writeFileSync(f, JSON.stringify(pkg));
    });
    const r = await verifyArtifact(t);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/manifest catalogVersion/);
  });
  it('fails when the tgz hash differs from provenance', async () => {
    const t = tampered('hash', (root) => writeFileSync(join(root, 'dist/extra.txt'), 'x'), false);
    const r = await verifyArtifact(t);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/tgz sha256/);
  });
  it('fails on unexpected files in the pack', async () => {
    const t = tampered('extra', (root) => writeFileSync(join(root, '.env'), 'SECRET=1'));
    const r = await verifyArtifact(t);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/unexpected files/);
  });
  it('fails with a different wire-version list in provenance', async () => {
    const prov = JSON.parse(readFileSync(good.provenance, 'utf8'));
    prov.supportedProtocolVersions = [1, 2];
    const p = join(work, 'prov-versions.json');
    writeFileSync(p, JSON.stringify(prov));
    const r = await verifyArtifact({ tgz: good.tgz, provenance: p });
    expect(r.ok).toBe(false);
  });
});
