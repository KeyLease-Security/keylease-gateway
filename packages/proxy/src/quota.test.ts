import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnChainQuota, QuotaCapacityWarning, type CallCommitter } from './quota.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeCommitter(): CallCommitter & { calls: Array<[string, number]> } {
  const calls: Array<[string, number]> = [];
  return {
    calls,
    useCalls: vi.fn(async (leaseId: string, count: number) => {
      calls.push([leaseId, count]);
      return {};
    }),
  };
}

describe('OnChainQuota', () => {
  it('batches calls per lease and commits them as one use_call per lease', async () => {
    const committer = fakeCommitter();
    const quota = new OnChainQuota({ committer, batchSize: 10, flushIntervalMs: 0 });

    quota.record('7');
    quota.record('7');
    quota.record('9');
    expect(quota.pendingFor('7')).toBe(2);
    expect(quota.pendingFor('9')).toBe(1);
    expect(committer.calls).toHaveLength(0);

    await quota.flush();

    expect(committer.calls).toEqual([
      ['7', 2],
      ['9', 1],
    ]);
    expect(quota.pendingFor('7')).toBe(0);
    await quota.close();
  });

  it('commits automatically once the batch size is reached', async () => {
    const committer = fakeCommitter();
    const quota = new OnChainQuota({ committer, batchSize: 3, flushIntervalMs: 0 });

    quota.record('3');
    quota.record('3');
    quota.record('3');

    await quota.flush();
    expect(committer.calls).toEqual([['3', 3]]);
    await quota.close();
  });

  it('flushes at the tracked-lease bound and eventually commits every call', async () => {
    const committer = fakeCommitter();
    const errors: Array<{ error: unknown; leaseId: string; count: number }> = [];
    const quota = new OnChainQuota({
      committer,
      batchSize: 100,
      maxTrackedLeases: 2,
      flushIntervalMs: 0,
      onError: (error, leaseId, count) => errors.push({ error, leaseId, count }),
    });

    quota.record('7');
    quota.record('7');
    quota.record('9');
    quota.record('11');
    quota.record('13');
    quota.record('15');

    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({
      error: expect.any(QuotaCapacityWarning),
      leaseId: '7',
      count: 2,
    });
    expect(errors[1]).toMatchObject({
      error: expect.any(QuotaCapacityWarning),
      leaseId: '11',
      count: 1,
    });

    await quota.close();

    expect(committer.calls).toEqual([
      ['7', 2],
      ['9', 1],
      ['11', 1],
      ['13', 1],
      ['15', 1],
    ]);
  });

  it('rejects invalid tracked-lease limits', () => {
    const committer = fakeCommitter();
    for (const maxTrackedLeases of [0, -1, Number.NaN, 1.5]) {
      expect(
        () => new OnChainQuota({ committer, maxTrackedLeases, flushIntervalMs: 0 }),
      ).toThrow(RangeError);
    }
  });

  it('requeues counts when a commit fails and reports the error', async () => {
    const errors: unknown[] = [];
    const committer: CallCommitter = {
      useCalls: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    };
    const quota = new OnChainQuota({
      committer,
      flushIntervalMs: 0,
      onError: (error) => errors.push(error),
    });

    quota.record('5');
    await quota.flush();

    expect(errors).toHaveLength(1);
    expect(quota.pendingFor('5')).toBe(1);
    await quota.close();
  });

  it('retries with jittered backoff and clears pending counts after success', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const calls: Array<[string, number]> = [];
    const committer: CallCommitter = {
      useCalls: vi.fn(async (leaseId: string, count: number) => {
        calls.push([leaseId, count]);
        if (calls.length === 1) throw new Error('rpc down');
        return {};
      }),
    };
    const quota = new OnChainQuota({
      committer,
      batchSize: 10,
      flushIntervalMs: 10,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 500,
    });

    quota.record('12');
    await quota.flush();
    expect(calls).toEqual([['12', 1]]);
    expect(quota.pendingFor('12')).toBe(1);

    await vi.advanceTimersByTimeAsync(49);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(calls).toEqual([
      ['12', 1],
      ['12', 1],
    ]);
    expect(quota.pendingFor('12')).toBe(0);
    await quota.close();
  });

  it('stops automatic retries at the configured attempt limit', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const errors: unknown[] = [];
    const committer: CallCommitter = {
      useCalls: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    };
    const quota = new OnChainQuota({
      committer,
      batchSize: 10,
      flushIntervalMs: 0,
      maxRetryAttempts: 3,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 500,
      onError: (error) => errors.push(error),
    });

    quota.record('13');
    await quota.flush();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(99);
    expect(committer.useCalls).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(committer.useCalls).toHaveBeenCalledTimes(3);
    expect(errors).toHaveLength(3);
    expect(quota.pendingFor('13')).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(committer.useCalls).toHaveBeenCalledTimes(3);
  });

  it('close() commits whatever is still pending', async () => {
    const committer = fakeCommitter();
    const quota = new OnChainQuota({ committer, flushIntervalMs: 0 });
    quota.record('11');
    await quota.close();
    expect(committer.calls).toEqual([['11', 1]]);
  });
});
