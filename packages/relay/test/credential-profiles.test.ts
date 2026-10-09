import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsCustodyStore } from '../src/custody/fs-store.js';
import {
  CredentialProfileConflictError,
  CredentialProfileStore,
  DEFAULT_CREDENTIAL_PROFILE_ID,
} from '../src/custody/profiles.js';

describe('CredentialProfileStore', () => {
  let root: string;
  let store: CredentialProfileStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'credential-profiles-'));
    store = new CredentialProfileStore(new FsCustodyStore({ root }));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('keeps named profiles isolated and lists metadata only', async () => {
    await store.update({ agentId: 'codex', profileId: 'personal' }, Buffer.from('first'));
    await store.update({ agentId: 'codex', profileId: 'work' }, Buffer.from('second'));

    const profiles = await store.list('codex');
    expect(profiles.map((p) => p.profileId)).toEqual(['personal', 'work']);
    expect(profiles.every((p) => p.health === 'active')).toBe(true);
    expect(JSON.stringify(profiles)).not.toContain('first');
    expect(JSON.stringify(profiles)).not.toContain('second');
    expect(profiles.every((p) => !('path' in p))).toBe(true);
  });

  it('adopts the legacy record as the explicit default without guessing named profiles', async () => {
    const raw = new FsCustodyStore({ root });
    await raw.put('agents/codex/auth.json', Buffer.from('legacy'));

    expect((await store.get({ agentId: 'codex', profileId: DEFAULT_CREDENTIAL_PROFILE_ID }))?.health).toBe('active');
    expect(await store.get({ agentId: 'codex', profileId: 'other' })).toBeNull();
  });

  it('serializes concurrent compare-and-set mutation across store instances', async () => {
    const first = await store.update({ agentId: 'codex', profileId: 'personal' }, Buffer.from('one'));
    const other = new CredentialProfileStore(new FsCustodyStore({ root }));

    const [updated, revoked] = await Promise.allSettled([
      store.update({ agentId: 'codex', profileId: 'personal' }, Buffer.from('two'), first.sha256),
      other.revoke({ agentId: 'codex', profileId: 'personal' }, first.sha256),
    ]);
    expect([updated, revoked].filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect([updated, revoked].find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(CredentialProfileConflictError),
    });
  });

  it('does not list revocation markers or unrelated profile files as credential records', async () => {
    const raw = new FsCustodyStore({ root });
    await raw.put('agents/codex/profiles/personal/.revoked', Buffer.from('marker'));
    await raw.put('agents/codex/profiles/personal/unrelated', Buffer.from('metadata'));
    expect(await store.list('codex')).toEqual([]);
  });

  it('compare-and-set update and revocation affect only the selected profile', async () => {
    const personal = await store.update({ agentId: 'codex', profileId: 'personal' }, Buffer.from('one'));
    const work = await store.update({ agentId: 'codex', profileId: 'work' }, Buffer.from('two'));

    await expect(
      store.update({ agentId: 'codex', profileId: 'personal' }, Buffer.from('new'), 'wrong'),
    ).rejects.toBeInstanceOf(CredentialProfileConflictError);
    await store.revoke({ agentId: 'codex', profileId: 'personal' }, personal.sha256);

    expect((await store.get({ agentId: 'codex', profileId: 'personal' }))?.health).toBe('revoked');
    expect((await store.get({ agentId: 'codex', profileId: 'work' }))?.sha256).toBe(work.sha256);
  });
});
