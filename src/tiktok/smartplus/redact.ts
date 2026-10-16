/**
 * Secret redaction. Used by audit events and by the auth helpers so that app secrets, access tokens and
 * auth codes never reach logs, audit tables or error messages.
 */
export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY = /(secret|token|password|authorization|credential)/i;
const QUERYISH = /\b(secret|app_secret|client_secret|access_token|refresh_token|auth_code)=([^&\s"']+)/gi;

/** Replace known secret values and `key=value` secrets inside a string. */
export function scrubString(s: string, secrets: readonly (string | undefined)[] = []): string {
  let out = s.replace(QUERYISH, (_m, k: string) => `${k}=${REDACTED}`);
  for (const sec of secrets) {
    if (sec && sec.length >= 4) out = out.split(sec).join(REDACTED);
  }
  return out;
}

/**
 * Deep-copy `value` with sensitive keys replaced by [REDACTED] and known secret values scrubbed from strings.
 * (A numeric `code` — TikTok's response code — is untouched; a string `code`/`auth_code` is redacted.)
 */
export function redact<T>(value: T, secrets: readonly (string | undefined)[] = []): T {
  return walk(value, secrets, 0) as T;
}

function walk(v: unknown, secrets: readonly (string | undefined)[], depth: number): unknown {
  if (depth > 12) return REDACTED;
  if (typeof v === 'string') return scrubString(v, secrets);
  if (Array.isArray(v)) return v.map((x) => walk(x, secrets, depth + 1));
  if (v instanceof Error) return scrubString(v.message, secrets);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k) || (k === 'code' && typeof val === 'string')) out[k] = REDACTED;
      else out[k] = walk(val, secrets, depth + 1);
    }
    return out;
  }
  return v;
}

/** `abcd…wxyz` style preview for UIs; never enough to reuse the secret. */
export function maskSecret(s: string): string {
  return s.length <= 8 ? '****' : `${s.slice(0, 2)}…${s.slice(-4)}`;
}
