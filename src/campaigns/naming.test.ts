import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDuplicateCampaignName, nameContainsCopyPrefix } from './naming.js';

test('duplicate name keeps the historical - API suffix and drops a repeated suffix', () => {
  assert.equal(buildDuplicateCampaignName('Mặt nạ mắt'), 'Mặt nạ mắt - API');
  assert.equal(buildDuplicateCampaignName('Mặt nạ mắt - API'), 'Mặt nạ mắt - API');
  assert.equal(buildDuplicateCampaignName('Mặt nạ mắt - api'), 'Mặt nạ mắt - API');
});

test('duplicate name does not add a Copy or COPIED_ prefix', () => {
  const name = buildDuplicateCampaignName('Lead DM');
  assert.equal(name, 'Lead DM - API');
  assert.equal(nameContainsCopyPrefix(name), false);
  assert.equal(nameContainsCopyPrefix('COPIED_nguon'), true);
  assert.equal(nameContainsCopyPrefix('Copy of camp'), true);
});
