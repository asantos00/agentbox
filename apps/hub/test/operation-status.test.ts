import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsOperationJournal, operationRequestHash } from '@agentbox/relay/operation-journal';
import { observeJournaledApiMutation } from '../app/(dashboard)/api/v1/lib/idempotency';
import { normalizedResult } from '../app/(dashboard)/api/v1/operations/[key]/route.js';

describe('controller operation status', () => {
  it('exposes a bounded code instead of a failed operation error', () => {
    expect(
      normalizedResult('agent.launch', {
        ok: false,
        error: 'secret-bearing backend detail /private/path',
      }),
    ).toEqual({ ok: false, errorCode: 'action_failed' });
    expect(normalizedResult('agent.launch', { ok: false, error: { unsafe: true } })).toEqual({
      ok: false,
      errorCode: 'action_failed',
    });
  });

  it('exposes bounded capability preparation outcomes for restart reconciliation', () => {
    const common = {
      capabilityProfileId: 'node',
      capabilities: ['node'],
      providerMutationId: 'agentbox-op-1234',
    };
    expect(
      normalizedResult('capability.prepare', {
        ...common,
        status: 'ready',
        readiness: { unsafe: 'not exposed' },
      }),
    ).toEqual({ ...common, status: 'ready' });
    expect(
      normalizedResult('capability.prepare', {
        ...common,
        status: 'failed',
        failure: 'secret provider detail',
      }),
    ).toEqual({ ...common, status: 'failed' });
  });

  it('distinguishes absent, committed, and ambiguous journal state', async () => {
    const journal = new FsOperationJournal(await mkdtemp(join(tmpdir(), 'agentbox-operations-')));
    await expect(observeJournaledApiMutation(journal, 'missing')).resolves.toEqual({
      state: 'absent',
    });

    const request = { boxId: 'box-1', agent: 'pi' };
    const begun = await journal.begin({ key: 'launch-1', kind: 'agent.launch', request });
    await expect(observeJournaledApiMutation(journal, 'launch-1')).resolves.toEqual({
      state: 'ambiguous',
      kind: 'agent.launch',
      requestHash: operationRequestHash('agent.launch', request),
      operationTag: begun.entry.tag,
    });

    const result = { ok: true, agent: 'pi', version: '0.85.1' };
    await journal.complete('launch-1', result);
    await expect(observeJournaledApiMutation(journal, 'launch-1')).resolves.toEqual({
      state: 'committed',
      kind: 'agent.launch',
      requestHash: operationRequestHash('agent.launch', request),
      operationTag: begun.entry.tag,
      result,
    });
  });
});
