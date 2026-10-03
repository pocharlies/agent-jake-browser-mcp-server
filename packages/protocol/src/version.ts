import { MAX_VERSIONS } from './constants.js';

/** Greatest common integer, independent of input order; null when disjoint. Inputs are not mutated. */
export function negotiateVersion(
  serverVersions: readonly number[],
  clientVersions: readonly number[],
): number | null {
  const client = new Set(clientVersions);
  let best: number | null = null;
  for (const v of serverVersions) {
    if (client.has(v) && (best === null || v > best)) best = v;
  }
  return best;
}

/** True for a non-empty, duplicate-free, bounded list of positive safe integers. */
export function isValidVersionList(list: unknown): list is number[] {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_VERSIONS) return false;
  if (!list.every((v) => Number.isSafeInteger(v) && v > 0)) return false;
  return new Set(list).size === list.length;
}
