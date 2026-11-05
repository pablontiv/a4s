import { validateReceipt } from '../safety/index.ts';

/** Git evidence is independently observed before entry; only local acceptance is atomic. */
export function acceptReceipt(authority, lease, expected, raw, evidence) {
  authority.commit(lease, 'result', expected, raw, (current) => {
    const result = validateReceipt(raw, expected, evidence, current.generation);
    if (!result.accepted) throw new Error(`receipt-rejected:${result.reason}`);
  });
}
