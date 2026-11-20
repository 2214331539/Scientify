import assert from 'node:assert/strict';
import test from 'node:test';

import { autoPrice, MIN_MARGIN, withAutoPrices } from '../src/billing/pricing.mjs';

test('a price is the cost plus 10%, in points, rounded up', () => {
  assert.equal(autoPrice(2), 220);
  assert.equal(autoPrice(0.2), 22);
  assert.equal(autoPrice(3), 330);
  assert.equal(autoPrice(0.5), 55);
  assert.equal(autoPrice(0.0123), 2);
  assert.equal(autoPrice(0), 0);
  assert.equal(autoPrice('x'), 0);
  assert.equal(MIN_MARGIN, 9);
});

test('missing prices follow the cost; set ones stay unless all are asked for', () => {
  const model = { costInput: 2, costCached: 0.2, costOutput: 3, priceInput: 400, priceCached: 0, priceOutput: 0 };
  assert.deepEqual(withAutoPrices(model), { ...model, priceInput: 400, priceCached: 22, priceOutput: 330 });
  assert.deepEqual(withAutoPrices(model, true), { ...model, priceInput: 220, priceCached: 22, priceOutput: 330 });
});
