import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from '../src/jwt.mjs';

test('JWT round trips and rejects expired or modified tokens', () => {
  const token = signToken({ sub: 'user-1', phone: '13800000000' }, 'a'.repeat(40), 60, 'test', 1000);
  assert.equal(verifyToken(token, 'a'.repeat(40), 'test', 1010).sub, 'user-1');
  assert.throws(() => verifyToken(token, 'a'.repeat(40), 'test', 1061));
  assert.throws(() => verifyToken(`${token}x`, 'a'.repeat(40), 'test', 1010));
});
