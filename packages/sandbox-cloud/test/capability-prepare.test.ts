import { describe, expect, it, vi } from 'vitest';
import { makeMockCloudBackend } from '../src/mock-backend.js';
import {
  prepareCloudCapability,
  type ReviewedCloudCapabilityProfile,
} from '../src/capability-prepare.js';

function profile(
  overrides: Partial<ReviewedCloudCapabilityProfile> = {},
): ReviewedCloudCapabilityProfile {
  return {
    id: 'fixture.browser',
    capabilities: ['browser.automation'],
    prepare: vi.fn().mockResolvedValue({ providerMutationId: 'mutation-1' }),
    observe: vi.fn().mockResolvedValue({ state: 'absent' }),
    readiness: vi.fn().mockResolvedValue({
      ready: true,
      checks: [{ id: 'browser-runtime', status: 'passed' }],
      observedAt: '2026-01-01T00:00:00.000Z',
    }),
    ...overrides,
  };
}

const target = {
  boxId: 'box-1',
  standingSlotId: 'slot-1',
  environment: 'non-production' as const,
  approved: true as const,
  endpoint: { backend: 'mock', sandboxId: 'sandbox-1' },
};

describe('cloud capability preparation', () => {
  it('runs only a server-resolved reviewed profile against the exact existing endpoint', async () => {
    const backend = makeMockCloudBackend({
      preloaded: [{ id: 'sandbox-1', name: 'approved-box' }],
    });
    const reviewed = profile();

    const out = await prepareCloudCapability({
      backend,
      target,
      profile: reviewed,
      operationTag: 'agentbox-op-fixture',
    });

    expect(out.status).toBe('ready');
    expect(out.providerMutationId).toBe('mutation-1');
    expect(reviewed.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: { sandboxId: 'sandbox-1' },
        operationTag: 'agentbox-op-fixture',
      }),
    );
    expect(backend.calls.some((call) => call.method === 'provision')).toBe(false);
    expect(backend.calls.some((call) => call.method === 'previewUrl')).toBe(false);
  });

  it('refuses endpoint mismatch before profile execution', async () => {
    const backend = makeMockCloudBackend({ name: 'other', preloaded: [{ id: 'sandbox-1' }] });
    const reviewed = profile();

    await expect(
      prepareCloudCapability({ backend, target, profile: reviewed, operationTag: 'op' }),
    ).rejects.toThrow(/endpoint backend mismatch/);
    expect(reviewed.prepare).not.toHaveBeenCalled();
  });

  it('refuses an unattested or missing target before profile execution', async () => {
    const backend = makeMockCloudBackend();
    const reviewed = profile();

    await expect(
      prepareCloudCapability({ backend, target, profile: reviewed, operationTag: 'op' }),
    ).rejects.toThrow(/does not exist/);
    expect(reviewed.prepare).not.toHaveBeenCalled();
  });

  it('records failed preparation evidence and runs reviewed cleanup', async () => {
    const backend = makeMockCloudBackend({ preloaded: [{ id: 'sandbox-1' }] });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const reviewed = profile({
      prepare: vi.fn().mockResolvedValue({ failure: 'preparation_failed' }),
      cleanup,
    });

    const out = await prepareCloudCapability({
      backend,
      target,
      profile: reviewed,
      operationTag: 'op',
    });

    expect(out).toMatchObject({
      status: 'failed',
      failure: 'preparation_failed',
      readiness: { ready: false, checks: [] },
      cleanup: { attempted: true, succeeded: true },
    });
    expect(reviewed.readiness).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('records failed readiness evidence and runs reviewed cleanup', async () => {
    const backend = makeMockCloudBackend({ preloaded: [{ id: 'sandbox-1' }] });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const reviewed = profile({
      readiness: vi.fn().mockResolvedValue({
        ready: false,
        checks: [{ id: 'browser-runtime', status: 'failed' }],
        observedAt: '2026-01-01T00:00:00.000Z',
      }),
      cleanup,
    });

    const out = await prepareCloudCapability({
      backend,
      target,
      profile: reviewed,
      operationTag: 'op',
    });

    expect(out).toMatchObject({
      status: 'failed',
      failure: 'readiness_failed',
      readiness: { ready: false },
      cleanup: { attempted: true, succeeded: true },
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('reconciles a provider-visible operation tag without repeating preparation', async () => {
    const backend = makeMockCloudBackend({ preloaded: [{ id: 'sandbox-1' }] });
    const reviewed = profile({
      observe: vi.fn().mockResolvedValue({ state: 'prepared', providerMutationId: 'mutation-1' }),
    });

    const out = await prepareCloudCapability({
      backend,
      target,
      profile: reviewed,
      operationTag: 'agentbox-op-fixture',
      reconcileOnly: true,
    });

    expect(out.state).toBe('completed');
    if (out.state === 'completed') expect(out.result.status).toBe('ready');
    expect(reviewed.prepare).not.toHaveBeenCalled();
    expect(reviewed.observe).toHaveBeenCalledOnce();
  });
});
