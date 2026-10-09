import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FsOperationJournal,
  OperationBlockedError,
  OperationConflictError,
  operationTag,
  runJournaledOperation,
} from '../src/operation-journal.js';

async function journal(): Promise<FsOperationJournal> {
  return new FsOperationJournal(await mkdtemp(join(tmpdir(), 'agentbox-operations-')));
}

describe('operation journal', () => {
  it('durably records pending before the external effect and completed afterwards', async () => {
    const store = await journal();
    let pendingOnDisk = false;
    const result = await runJournaledOperation({
      journal: store,
      key: 'task-1:create-box',
      kind: 'box.create',
      request: { provider: 'docker', task: 'task-1' },
      reconcile: () => Promise.resolve({ state: 'absent' }),
      effect: async (entry) => {
        pendingOnDisk = (await store.read(entry.key))?.status === 'pending';
        return { boxId: 'box-1' };
      },
    });
    expect(pendingOnDisk).toBe(true);
    expect(result.result).toEqual({ boxId: 'box-1' });
    expect((await store.read('task-1:create-box'))?.status).toBe('completed');
  });

  it('replays an identical completed request without invoking the effect', async () => {
    const store = await journal();
    const effect = vi.fn().mockResolvedValue({ boxId: 'box-1' });
    const input = {
      journal: store,
      key: 'same-key',
      kind: 'box.create' as const,
      request: { provider: 'docker' },
      reconcile: () => Promise.resolve({ state: 'absent' as const }),
      effect,
    };
    await runJournaledOperation(input);
    const replay = await runJournaledOperation(input);
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual({ boxId: 'box-1' });
    expect(effect).toHaveBeenCalledOnce();
  });

  it('rejects mismatched reuse of an idempotency key', async () => {
    const store = await journal();
    await store.begin({ key: 'key', kind: 'task.create', request: { title: 'one' } });
    await expect(
      store.begin({ key: 'key', kind: 'task.create', request: { title: 'two' } }),
    ).rejects.toBeInstanceOf(OperationConflictError);
  });

  it('reconciles a crash immediately after external commit without a second effect', async () => {
    const store = await journal();
    const effect = vi.fn().mockResolvedValue({ session: 'pi' });
    await expect(
      runJournaledOperation({
        journal: store,
        key: 'launch-key',
        kind: 'agent.launch',
        request: { boxId: 'box-1', agent: 'pi' },
        reconcile: () => Promise.resolve({ state: 'absent' }),
        effect,
        crashAt: 'after-external',
      }),
    ).rejects.toThrow(/injected crash/);

    const replay = await runJournaledOperation({
      journal: store,
      key: 'launch-key',
      kind: 'agent.launch',
      request: { boxId: 'box-1', agent: 'pi' },
      reconcile: () => Promise.resolve({ state: 'completed', result: { session: 'pi' } }),
      effect,
    });
    expect(replay.replayed).toBe(true);
    expect(effect).toHaveBeenCalledOnce();
  });

  it('blocks a pending operation when reconciliation is impossible', async () => {
    const store = await journal();
    await store.begin({ key: 'opaque', kind: 'task.assign', request: { task: 'T-1' } });
    await expect(
      runJournaledOperation({
        journal: store,
        key: 'opaque',
        kind: 'task.assign',
        request: { task: 'T-1' },
        reconcile: () =>
          Promise.resolve({ state: 'unreconcilable', reason: 'provider has no operation tags' }),
        effect: () => Promise.resolve({ ok: true }),
      }),
    ).rejects.toBeInstanceOf(OperationBlockedError);
    expect((await store.read('opaque'))?.status).toBe('blocked');
  });

  it('derives a stable provider-visible tag from the request key', () => {
    expect(operationTag('task/attempt/launch')).toBe(operationTag('task/attempt/launch'));
    expect(operationTag('task/attempt/launch')).toMatch(/^agentbox-op-[a-f0-9]{16}$/);
  });
});
