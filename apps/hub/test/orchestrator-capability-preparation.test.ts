import { describe, expect, it, vi } from 'vitest';
import type { CloudBackend } from '@agentbox/core';
import { createOrchestratorCapabilityPreparation } from '../lib/orchestrator-capability-preparation';

describe('orchestrator capability preparation', () => {
  it('accepts only reviewed dispatch boxes on the configured non-production backend', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: 'v24\n11\n', stderr: '' }));
    const backend = {
      name: 'remote-docker',
      get: vi.fn(async (sandboxId: string) => ({ sandboxId })),
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
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: 'workstation/dispatch-one' }),
      'node --version && npm --version',
    );
    expect(await service.profiles.resolve('shell-command')).toBeNull();
  });
});
