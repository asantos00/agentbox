import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsCustodyStore } from '../src/custody/fs-store.js';
import { CredentialProfileStore } from '../src/custody/profiles.js';
import { ProfileLifecycle } from '../src/profile-lifecycle.js';

describe('ProfileLifecycle', () => {
  let root: string; let profiles: CredentialProfileStore; let lifecycle: ProfileLifecycle;
  const selected = { agentId: 'codex', profileId: 'personal' };
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'profile-life-')); profiles = new CredentialProfileStore(new FsCustodyStore({ root: join(root, 'custody') })); lifecycle = new ProfileLifecycle(profiles, join(root, 'homes')); await profiles.update(selected, Buffer.from('fixture-a')); });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('uses private server-derived homes and cleans transient material', async () => {
    await lifecycle.materialize(selected);
    expect(await lifecycle.homeModes(selected)).toEqual({ home: 0o700, credential: 0o600 });
    await lifecycle.cleanup(selected);
    await expect(lifecycle.homeModes(selected)).rejects.toThrow();
  });
  it('CAS-refreshes only the selected profile and clears one reauth request', async () => {
    await profiles.update({ agentId: 'codex', profileId: 'work' }, Buffer.from('fixture-work'));
    await profiles.requestReauthentication(selected, 'refresh_failed');
    await expect(lifecycle.refresh(selected, { refresh: async () => ({ data: Buffer.from('fixture-b'), identityMatch: true }) })).resolves.toEqual({ ok: true });
    expect(await profiles.reauthenticationRequest(selected)).toBeNull();
    expect((await profiles.readForStage({ agentId: 'codex', profileId: 'work' }))?.toString()).toBe('fixture-work');
  });
  it('fails closed and deduplicates reauthentication on mismatch, revocation, and concurrent CAS', async () => {
    await expect(lifecycle.refresh(selected, { refresh: async () => ({ data: Buffer.from('other'), identityMatch: false }) })).resolves.toMatchObject({ code: 'identity_mismatch' });
    const first = await profiles.reauthenticationRequest(selected);
    await expect(lifecycle.refresh(selected, null)).resolves.toMatchObject({ code: 'refresh_unsupported' });
    expect((await profiles.reauthenticationRequest(selected))?.requestedAt).toBe(first?.requestedAt);
    await profiles.revoke(selected);
    await expect(lifecycle.refresh(selected, null)).resolves.toMatchObject({ code: 'profile_revoked' });
  });
});
