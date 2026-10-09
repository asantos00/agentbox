import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsOperationJournal } from '../src/operation-journal.js';
import {
  startRelayServer,
  type RelayServerHandle,
  type RelayServerOptions,
} from '../src/server.js';
import type {
  ApprovedCapabilityProfile,
  CapabilityPreparationOutcome,
  CapabilityTargetProof,
} from '../src/capability-prepare.js';

const route = '/api/v1/internal/capabilities/prepare';
const token = 'capability-test-token';
const target: CapabilityTargetProof = {
  boxId: 'box-1',
  standingSlotId: 'slot-1',
  environment: 'non-production',
  approved: true,
  endpoint: { backend: 'mock', sandboxId: 'sandbox-1' },
};
const ready: CapabilityPreparationOutcome = {
  status: 'ready',
  capabilityProfileId: 'fixture.browser',
  capabilities: ['browser.automation'],
  providerMutationId: 'mutation-1',
  readiness: {
    ready: true,
    checks: [{ id: 'browser-runtime', status: 'passed' }],
    observedAt: '2026-01-01T00:00:00.000Z',
  },
  cleanup: { attempted: false, succeeded: false },
};

async function post(handle: RelayServerHandle, body: unknown, bearer = token) {
  const port = (handle.server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${String(port)}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function register(handle: RelayServerHandle): Promise<void> {
  const port = (handle.server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${String(port)}/admin/register-box`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      boxId: 'box-1',
      token: 'box-token',
      name: 'approved-box',
      kind: 'cloud',
      backend: 'mock',
      sandboxId: 'sandbox-1',
    }),
  });
  expect(response.status).toBe(204);
}

function profile(overrides: Partial<ApprovedCapabilityProfile> = {}): ApprovedCapabilityProfile {
  return {
    id: 'fixture.browser',
    capabilities: ['browser.automation'],
    prepare: vi.fn().mockResolvedValue(ready),
    reconcile: vi.fn().mockResolvedValue({ state: 'absent' }),
    ...overrides,
  };
}

async function fixture(
  root: string,
  reviewed: ApprovedCapabilityProfile,
  overrides: Partial<NonNullable<RelayServerOptions['capabilityPreparation']>> = {},
): Promise<RelayServerHandle> {
  const handle = await startRelayServer({
    port: 0,
    host: '127.0.0.1',
    capabilityPreparationToken: token,
    capabilityPreparation: {
      profiles: { resolve: async (id) => (id === reviewed.id ? reviewed : null) },
      targets: { verify: async () => target },
      journal: new FsOperationJournal(join(root, 'operations')),
      ...overrides,
    },
  });
  await register(handle);
  return handle;
}

const handles: RelayServerHandle[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('capability preparation route', () => {
  it('fails closed with no production profile registry configured', async () => {
    const handle = await startRelayServer({ port: 0, host: '127.0.0.1' });
    handles.push(handle);
    expect(
      (
        await post(handle, {
          boxId: 'box-1',
          capabilityProfileId: 'fixture.browser',
          operationKey: 'op-1',
        })
      ).status,
    ).toBe(503);
  });

  it('requires the dedicated capability bearer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capability-route-'));
    roots.push(root);
    const reviewed = profile();
    const handle = await fixture(root, reviewed);
    handles.push(handle);

    const response = await post(
      handle,
      {
        boxId: 'box-1',
        capabilityProfileId: 'fixture.browser',
        operationKey: 'op-auth',
      },
      'ordinary-hub-token',
    );
    expect(response.status).toBe(401);
    expect(reviewed.prepare).not.toHaveBeenCalled();
  });

  it('rejects raw/unknown action fields before profile execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capability-route-'));
    roots.push(root);
    const reviewed = profile();
    const handle = await fixture(root, reviewed);
    handles.push(handle);

    const response = await post(handle, {
      boxId: 'box-1',
      capabilityProfileId: 'fixture.browser',
      operationKey: 'op-raw',
      command: 'curl credentials.invalid',
    });

    expect(response.status).toBe(400);
    expect(reviewed.prepare).not.toHaveBeenCalled();
  });

  it('rejects unknown profiles, boxes, and unapproved standing slots before execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capability-route-'));
    roots.push(root);
    const reviewed = profile();
    const handle = await fixture(root, reviewed);
    handles.push(handle);

    expect(
      (await post(handle, { boxId: 'box-1', capabilityProfileId: 'unknown', operationKey: 'op-u' }))
        .status,
    ).toBe(404);
    expect(
      (
        await post(handle, {
          boxId: 'missing',
          capabilityProfileId: 'fixture.browser',
          operationKey: 'op-b',
        })
      ).status,
    ).toBe(404);
    expect(reviewed.prepare).not.toHaveBeenCalled();

    await handle.close();
    handles.splice(handles.indexOf(handle), 1);
    const denied = await fixture(root, reviewed, { targets: { verify: async () => null } });
    handles.push(denied);
    expect(
      (
        await post(denied, {
          boxId: 'box-1',
          capabilityProfileId: 'fixture.browser',
          operationKey: 'op-d',
        })
      ).status,
    ).toBe(409);
    expect(reviewed.prepare).not.toHaveBeenCalled();
  });

  it('replays a repeat operation key and rejects mismatched reuse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capability-route-'));
    roots.push(root);
    const reviewed = profile();
    const handle = await fixture(root, reviewed);
    handles.push(handle);

    const request = {
      boxId: 'box-1',
      capabilityProfileId: 'fixture.browser',
      operationKey: 'op-repeat',
    };
    const first = await post(handle, request);
    const replay = await post(handle, request);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, result: { status: 'ready' } });
    expect(reviewed.prepare).toHaveBeenCalledOnce();

    const mismatch = await post(handle, { ...request, boxId: 'box-other' });
    expect(mismatch.status).toBe(409);
    expect(reviewed.prepare).toHaveBeenCalledOnce();
  });

  it('reconciles one crash after provider commit without repeating the effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capability-route-'));
    roots.push(root);
    let committed = false;
    const prepare = vi.fn(async () => {
      committed = true;
      return ready;
    });
    const reviewed = profile({
      prepare,
      reconcile: vi.fn(async () =>
        committed ? { state: 'completed' as const, result: ready } : { state: 'absent' as const },
      ),
    });
    const crashed = await fixture(root, reviewed, { crashAt: 'after-external' });
    handles.push(crashed);
    const request = {
      boxId: 'box-1',
      capabilityProfileId: 'fixture.browser',
      operationKey: 'op-crash',
    };

    expect((await post(crashed, request)).status).toBe(500);
    await crashed.close();
    handles.splice(handles.indexOf(crashed), 1);

    const recovered = await fixture(root, reviewed);
    handles.push(recovered);
    const replay = await post(recovered, request);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, result: { status: 'ready' } });
    expect(prepare).toHaveBeenCalledOnce();
    expect(reviewed.reconcile).toHaveBeenCalledOnce();
  });

  it('retains readiness failure evidence and cleanup status in the failed job response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capability-route-'));
    roots.push(root);
    const failed: CapabilityPreparationOutcome = {
      ...ready,
      status: 'failed',
      failure: 'readiness_failed',
      readiness: {
        ...ready.readiness,
        ready: false,
        checks: [{ id: 'browser-runtime', status: 'failed' }],
      },
      cleanup: { attempted: true, succeeded: true },
    };
    const reviewed = profile({ prepare: vi.fn().mockResolvedValue(failed) });
    const handle = await fixture(root, reviewed);
    handles.push(handle);

    const response = await post(handle, {
      boxId: 'box-1',
      capabilityProfileId: 'fixture.browser',
      operationKey: 'op-failed',
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: {
        code: 'capability_not_ready',
        details: { result: { readiness: { ready: false }, cleanup: { succeeded: true } } },
      },
    });
  });
});
