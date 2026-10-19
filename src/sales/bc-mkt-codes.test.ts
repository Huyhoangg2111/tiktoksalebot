import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getConfiguredOtherMktCode,
  getPrimaryMktCode,
  resolveOtherMktCodes,
} from './bc-mkt-codes.js';

test('getPrimaryMktCode uses TARGET_MKT_CODE then default', () => {
  assert.equal(getPrimaryMktCode({ TARGET_MKT_CODE: ' MKT.A ' }), 'MKT.A');
  assert.equal(getPrimaryMktCode({}), 'MKT80.HOÀNG-TH');
});

test('getConfiguredOtherMktCode reads OTHER_MKT_CODE', () => {
  assert.equal(getConfiguredOtherMktCode({ OTHER_MKT_CODE: ' MKT.CT ' }), 'MKT.CT');
  assert.equal(getConfiguredOtherMktCode({}), undefined);
  assert.equal(getConfiguredOtherMktCode({ OTHER_MKT_CODE: '   ' }), undefined);
});

test('resolveOtherMktCodes prefers OTHER_MKT_CODE over dashboard list', () => {
  assert.deepEqual(
    resolveOtherMktCodes({
      primaryMktCode: 'MKT80.HOÀNG-TH',
      configuredOther: 'MKT.CT',
      dashboardCodes: ['MKT80.HOÀNG-TH', 'MKT.OTHER'],
    }),
    ['MKT.CT']
  );
});

test('resolveOtherMktCodes falls back to non-primary dashboard codes', () => {
  assert.deepEqual(
    resolveOtherMktCodes({
      primaryMktCode: 'MKT80.HOÀNG-TH',
      dashboardCodes: ['MKT.B', 'MKT80.HOÀNG-TH', 'MKT.A', 'MKT.A', ''],
    }),
    ['MKT.A', 'MKT.B']
  );
});

test('resolveOtherMktCodes returns empty when only primary exists', () => {
  assert.deepEqual(
    resolveOtherMktCodes({
      primaryMktCode: 'MKT80.HOÀNG-TH',
      dashboardCodes: ['MKT80.HOÀNG-TH', 'mkt80.hoàng-th'],
    }),
    []
  );
});
