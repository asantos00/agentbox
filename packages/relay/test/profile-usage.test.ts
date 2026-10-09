import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsCustodyStore } from '../src/custody/fs-store.js';
import { CredentialProfileStore } from '../src/custody/profiles.js';
import { ProfileUsageService } from '../src/profile-usage.js';

describe('ProfileUsageService', () => {
  let root: string;
  let profiles: CredentialProfileStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'profile-usage-'));
    profiles = new CredentialProfileStore(new FsCustodyStore({ root }));
    await profiles.update({ agentId: 'codex', profileId: 'personal' }, Buffer.from('fixture-personal'));
    await profiles.update({ agentId: 'codex', profileId: 'work' }, Buffer.from('fixture-work'));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('passes only the selected stable profile identity to the helper and returns metadata only', async () => {
    const inspect = vi.fn(async () => ({
      provider: 'codex', providerIdentityFingerprint: 'fixture-id', identityMatch: true,
      windows: [{ used: 1, limit: 10, resetAt: '2026-01-01T00:00:00.000Z' }], plan: 'fixture', credits: 3,
      status: 'active' as const, reauthRequired: false, source: 'fixture', observedAt: '2025-12-31T00:00:00.000Z',
      freshness: 'exact' as const, confidence: 'exact' as const,
    }));
    const service = new ProfileUsageService(profiles, { inspect });
    const result = await service.get({ agentId: 'codex', profileId: 'personal' });

    expect(inspect).toHaveBeenCalledWith({ agentId: 'codex', profileId: 'personal' });
    expect(JSON.stringify(result)).not.toContain('fixture-personal');
    expect(JSON.stringify(result)).not.toContain('fixture-work');
    expect(result).toMatchObject({ version: 1, agentId: 'codex', profileId: 'personal', identityMatch: true });
  });

  it('fails closed before invoking the helper for revoked or missing profiles', async () => {
    const inspect = vi.fn();
    const service = new ProfileUsageService(profiles, { inspect });
    await profiles.revoke({ agentId: 'codex', profileId: 'personal' });

    await expect(service.get({ agentId: 'codex', profileId: 'personal' })).resolves.toMatchObject({ status: 'revoked' });
    await expect(service.get({ agentId: 'codex', profileId: 'missing' })).resolves.toMatchObject({ status: 'unavailable' });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('coalesces concurrent selected-profile checks and converts identity mismatch to reauthentication-required', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const inspect = vi.fn(async () => {
      await wait;
      return { provider: 'codex', identityMatch: false, windows: [], status: 'active' as const,
        reauthRequired: false, source: 'fixture', observedAt: new Date().toISOString(), freshness: 'exact' as const, confidence: 'exact' as const };
    });
    const service = new ProfileUsageService(profiles, { inspect });
    const one = service.get({ agentId: 'codex', profileId: 'personal' });
    const two = service.get({ agentId: 'codex', profileId: 'personal' });
    release();
    await expect(one).resolves.toMatchObject({ status: 'identity-mismatch', reauthRequired: true, identityMatch: false });
    await two;
    expect(inspect).toHaveBeenCalledTimes(1);
  });
});
