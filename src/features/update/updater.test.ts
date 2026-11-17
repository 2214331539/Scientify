import { describe, expect, it } from 'vitest';
import { describeUpdateError, inRollout, rolloutBucket } from './updater';

describe('rollout', () => {
  it('puts a device in the same place for a version, and spreads devices out', () => {
    expect(rolloutBucket('device-a', '0.4.0')).toBe(rolloutBucket('device-a', '0.4.0'));
    const buckets = new Set(
      Array.from({ length: 200 }, (_, index) => rolloutBucket(`device-${index}`, '0.4.0')),
    );
    expect(buckets.size).toBeGreaterThan(60);
    for (const bucket of buckets) expect(bucket).toBeGreaterThanOrEqual(0);
    for (const bucket of buckets) expect(bucket).toBeLessThan(100);
  });

  it('offers an update to the rollout share, everyone when asked, nobody once stopped', () => {
    expect(inRollout(undefined, 99, false)).toBe(true);
    expect(inRollout(10, 9, false)).toBe(true);
    expect(inRollout(10, 10, false)).toBe(false);
    expect(inRollout(10, 50, true)).toBe(true);
    expect(inRollout(0, 0, true)).toBe(false);
  });
});

it('says why an update failed in words people understand', () => {
  expect(
    describeUpdateError('the platform `darwin-aarch64` was not found on the response'),
  ).toContain('还在准备中');
  expect(describeUpdateError(new Error('Signature verification failed'))).toContain('签名');
  expect(describeUpdateError('error sending request for url')).toContain('网络');
});
