import { randomBytes } from 'node:crypto';

export type ConfirmationKind = 'duplicate' | 'budget' | 'bid' | 'delete-partial' | 'resume';

export interface DuplicateConfirmPayload {
  campaignId: string;
  quantity: number;
  budget?: number;
  bid?: number;
  campaignName: string;
}

export interface BudgetConfirmPayload {
  campaignId: string;
  budget: number;
  mode?: string;
}

export interface BidConfirmPayload {
  campaignId: string;
  bid: number;
}

export interface DeleteConfirmPayload {
  campaignId: string;
}

export interface ResumeConfirmPayload {
  sourceCampaignId: string;
  newCampaignId: string;
  adgroupId?: string;
  budget?: number;
  bid?: number;
}

export type ConfirmationPayload =
  | DuplicateConfirmPayload
  | BudgetConfirmPayload
  | BidConfirmPayload
  | DeleteConfirmPayload
  | ResumeConfirmPayload;

export interface PendingConfirmation {
  kind: ConfirmationKind;
  actor: string;
  createdAt: number;
  summary: string;
  payload: ConfirmationPayload;
}

const TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, PendingConfirmation>();

function purgeExpired(now = Date.now()): void {
  for (const [token, item] of pending) {
    if (now - item.createdAt > TTL_MS) pending.delete(token);
  }
}

export function createConfirmation(input: Omit<PendingConfirmation, 'createdAt'>): string {
  purgeExpired();
  const token = randomBytes(4).toString('hex');
  pending.set(token, { ...input, createdAt: Date.now() });
  return token;
}

export function peekConfirmation(token: string): PendingConfirmation | undefined {
  purgeExpired();
  return pending.get(token);
}

/** Returns the action once. A second confirm with the same token does nothing. */
export function consumeConfirmation(token: string): PendingConfirmation | undefined {
  purgeExpired();
  const item = pending.get(token);
  if (!item) return undefined;
  pending.delete(token);
  return item;
}

export function cancelConfirmation(token: string): boolean {
  purgeExpired();
  return pending.delete(token);
}
