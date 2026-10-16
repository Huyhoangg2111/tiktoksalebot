import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PartialDuplicateError,
  assertCopyQuantity,
  buildPausedShellBody,
  canDeletePartialClone,
  isSignerFallbackEnabled,
  runCopyLoop,
} from './duplicate-safety.js';

test('delete is limited to API-named clones or empty copies', () => {
  assert.equal(canDeletePartialClone({
    campaignName: 'Lead - API',
    operationStatus: 'DISABLE',
    adCount: 2,
    loggedAsClone: true,
  }).ok, true);
  assert.equal(canDeletePartialClone({
    campaignName: 'Lead - API',
    operationStatus: 'DISABLE',
    adCount: 0,
    loggedAsClone: false,
  }).ok, true);
  assert.equal(canDeletePartialClone({
    campaignName: 'Lead - API',
    operationStatus: 'ENABLE',
    adCount: 0,
    loggedAsClone: true,
  }).ok, false);
  assert.equal(canDeletePartialClone({
    campaignName: 'Lead thật',
    operationStatus: 'DISABLE',
    adCount: 0,
    loggedAsClone: true,
  }).ok, false);
  assert.equal(canDeletePartialClone({
    campaignName: 'Lead - API',
    operationStatus: 'DISABLE',
    adCount: 1,
    loggedAsClone: false,
  }).ok, false);
});

test('signer fallback is off unless explicitly enabled', () => {
  const previous = process.env.SMARTPLUS_SIGNER_FALLBACK;
  delete process.env.SMARTPLUS_SIGNER_FALLBACK;
  assert.equal(isSignerFallbackEnabled(), false);
  process.env.SMARTPLUS_SIGNER_FALLBACK = '0';
  assert.equal(isSignerFallbackEnabled(), false);
  process.env.SMARTPLUS_SIGNER_FALLBACK = '1';
  assert.equal(isSignerFallbackEnabled(), true);
  delete process.env.SMARTPLUS_SIGNER_FALLBACK;
  assert.equal(isSignerFallbackEnabled(true), true);
  if (previous === undefined) delete process.env.SMARTPLUS_SIGNER_FALLBACK;
  else process.env.SMARTPLUS_SIGNER_FALLBACK = previous;
});

test('copy quantity stays at 3 until a logged success, then 10', () => {
  assert.equal(assertCopyQuantity(3, 0), 3);
  assert.throws(() => assertCopyQuantity(4, 0), /tối đa 3/);
  assert.equal(assertCopyQuantity(10, 1), 10);
  assert.throws(() => assertCopyQuantity(11, 1), /tối đa 10/);
});

test('copy loop stops at the first error and keeps partial ids', async () => {
  let calls = 0;
  const outcome = await runCopyLoop(3, async () => {
    calls += 1;
    if (calls === 1) return { campaignId: '111' };
    throw new PartialDuplicateError('40002', '222');
  });
  assert.equal(calls, 2);
  assert.deepEqual(outcome.created.map(item => item.campaignId), ['111']);
  assert.deepEqual(outcome.partialIds, ['222']);
  assert.equal(outcome.stopped, true);
  assert.match(outcome.error || '', /40002/);
});

test('paused shell create carries a numeric request id', () => {
  const body = buildPausedShellBody({
    advertiserId: '9',
    campaignName: 'Lead - API',
    objectiveType: 'LEAD_GENERATION',
    requestId: '42',
  });
  assert.equal(body.operation_status, 'DISABLE');
  assert.equal(body.request_id, '42');
  assert.throws(() => buildPausedShellBody({
    advertiserId: '9',
    campaignName: 'Lead - API',
    objectiveType: 'LEAD_GENERATION',
    requestId: 'not-a-number',
  }), /request_id/);
});
