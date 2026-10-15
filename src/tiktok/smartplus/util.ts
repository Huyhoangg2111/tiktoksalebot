import { createHash, randomBytes } from 'node:crypto';
import { TikTokError } from './errors.js';

/**
 * TikTok `request_id` for create/copy calls must be "a string representation of a 64-bit integer".
 * - With a `seed`: deterministic (same seed => same id) => safe retries of the same logical operation.
 * - Without: random.
 * We use 62 bits, always > 0, so it fits signed 64-bit and JS BigInt.
 */
export function generateRequestId(seed?: string): string {
  const bytes = seed ? createHash('sha256').update(seed).digest().subarray(0, 8) : randomBytes(8);
  let n = bytes.readBigUInt64BE(0) & ((1n << 62n) - 1n);
  if (n === 0n) n = 1n;
  return n.toString();
}

/** `YYYY-MM-DD HH:MM:SS` in UTC (the format TikTok expects for schedule fields). */
export function formatUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export class InputValidationError extends TikTokError {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid input:\n- ${issues.join('\n- ')}`);
    this.issues = issues;
  }
}

/** Raised when a safety rule is violated (e.g. ENABLE without allowEnable, budget over cap). */
export class SafetyError extends TikTokError {}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Remove keys whose value is undefined (TikTok may reject explicit nulls; JSON drops undefined anyway). */
export function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
