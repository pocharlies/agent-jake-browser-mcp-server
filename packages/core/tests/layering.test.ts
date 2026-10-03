import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(new URL('../../..', import.meta.url).pathname);
const FORBIDDEN = /house-pocharlies|house-staticduo|op-safe/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('core has no houses (D2)', () => {
  for (const pkg of ['packages/core', 'packages/protocol']) {
    it(`${pkg}: no reference to a house adapter or op-safe anywhere in the package`, () => {
      const offenders = walk(join(root, pkg))
        .filter((f) => !f.endsWith('layering.test.ts'))
        .filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')));
      expect(offenders).toEqual([]);
    });
  }
});
