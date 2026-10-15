/**
 * Minimal audit hook. Every state-changing call made by this module emits one event, so the bot can
 * persist "who did what" (e.g. into its sqlite DB). Sinks must not throw; if they do it is swallowed.
 */
import { appendFileSync } from 'node:fs';
import { redact, scrubString } from './redact.js';

export interface AuditEvent {
  ts: string; // ISO
  action: string; // e.g. 'smartplus.create.campaign', 'smartplus.copy.task_create'
  advertiser_id: string;
  actor?: string | undefined; // e.g. telegram user id - pass through options.actor
  request?: unknown; // payload sent (never contains the token)
  response?: unknown; // ids / status / error
  ok: boolean;
}

export type AuditSink = (event: AuditEvent) => void | Promise<void>;

export async function emitAudit(sink: AuditSink | undefined, e: Omit<AuditEvent, 'ts'>): Promise<void> {
  if (!sink) return;
  try {
    // Secrets (tokens, app secret, auth codes) are redacted here, whatever the caller passes.
    await sink({ ts: new Date().toISOString(), ...e, request: redact(e.request), response: redact(e.response) });
  } catch {
    /* audit must never break the main flow */
  }
}

/** Handy default: one JSON line per event on stdout. */
export const consoleAudit: AuditSink = (e) => {
  console.log(JSON.stringify(e));
};

/**
 * Append-only JSON-lines file sink (created with mode 0600). Events are already redacted by emitAudit; as a second layer every
 * line is also scrubbed of the given secrets (e.g. the access token). Git-ignore the file.
 */
export function fileAudit(path: string, secrets: (string | undefined)[] = []): AuditSink {
  return (e) => {
    appendFileSync(path, scrubString(JSON.stringify(e), secrets) + '\n', { mode: 0o600 });
  };
}
