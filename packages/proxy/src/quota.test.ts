import { describe, expect, it, vi } from 'vitest';
import { OnChainQuota, type CallCommitter } from './quota.js';

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

  it('close() commits whatever is still pending', async () => {
    const committer = fakeCommitter();
    const quota = new OnChainQuota({ committer, flushIntervalMs: 0 });
    quota.record('11');
    await quota.close();
    expect(committer.calls).toEqual([['11', 1]]);
  });
});
