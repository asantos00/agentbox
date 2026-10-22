import { describe, expect, it, vi } from 'vitest';
import type { CloudBackend } from '@agentbox/core';
import { createOrchestratorCapabilityPreparation } from '../lib/orchestrator-capability-preparation';

describe('orchestrator capability preparation', () => {
  it('accepts only reviewed dispatch boxes on the configured non-production backend', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: 'v24\n11\n', stderr: '' }));
    const start = vi.fn(async () => undefined);
    const backend = {
      name: 'remote-docker',
      get: vi.fn(async (sandboxId: string) => ({ sandboxId })),
      state: vi.fn(async () => 'stopped' as const),
      start,
      exec,
    } as unknown as CloudBackend;
    const service = createOrchestratorCapabilityPreparation({
      resolver: { resolveBackend: async () => backend },
      backend: 'remote-docker',
      boxNamePrefix: 'dispatch-',
    });
    const registration = {
      boxId: 'box-one',
      token: 'token',
      name: 'dispatch-one',
      registeredAt: '2026-10-19T00:00:00.000Z',
      kind: 'cloud' as const,
      backend: 'remote-docker',
      sandboxId: 'workstation/dispatch-one',
    };
    const target = await service.targets.verify(registration);
    expect(target).not.toBeNull();
    expect(await service.targets.verify({ ...registration, name: 'manual-box' })).toBeNull();
    expect(await service.targets.verify({ ...registration, backend: 'daytona' })).toBeNull();

    const profile = await service.profiles.resolve('node');
    expect(profile).not.toBeNull();
    const result = await profile!.prepare(target!, 'operation-one');
    expect(result.status).toBe('ready');
    expect(result.capabilities).toEqual(['node']);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: 'workstation/dispatch-one' }),
    );
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: 'workstation/dispatch-one' }),
      'node --version && npm --version',
    );
    expect(await service.profiles.resolve('shell-command')).toBeNull();
  });

  it('returns a bounded failed result when provider readiness throws', async () => {
    const backend = {
      name: 'remote-docker',
      get: vi.fn(async (sandboxId: string) => ({ sandboxId })),
      state: vi.fn(async () => 'running' as const),
      exec: vi.fn(async () => {
        throw new Error('secret provider detail');
      }),
    } as unknown as CloudBackend;
    const service = createOrchestratorCapabilityPreparation({
      resolver: { resolveBackend: async () => backend },
      backend: 'remote-docker',
      boxNamePrefix: 'fleet-',
    });
    const target = await service.targets.verify({
      boxId: 'box-one',
      token: 'token',
      name: 'fleet-one',
      registeredAt: '2026-10-19T00:00:00.000Z',
      kind: 'cloud',
      backend: 'remote-docker',
      sandboxId: 'workstation/fleet-one',
    });
    const profile = await service.profiles.resolve('node');
    const result = await profile!.prepare(target!, 'operation-one');
    expect(result.status).toBe('failed');
    expect(result.failure).toBe('readiness_failed');
    expect(JSON.stringify(result)).not.toContain('secret provider detail');
  });
});
