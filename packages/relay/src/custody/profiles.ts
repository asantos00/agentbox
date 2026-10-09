import { resolveAgentSpec } from '@agentbox/sandbox-core';
import type { CredentialProfileSelection } from '@agentbox/core';
import type { CustodyEntry, CustodyStore } from './store.js';

export const DEFAULT_CREDENTIAL_PROFILE_ID = 'default';

const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type CredentialProfileHealth = 'active' | 'revoked';

export interface CredentialProfileMetadata {
  agentId: string;
  profileId: string;
  health: CredentialProfileHealth;
  sha256: string;
  size: number;
  updatedAt: string;
}

export class CredentialProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialProfileError';
  }
}

export class CredentialProfileConflictError extends CredentialProfileError {
  constructor() {
    super('credential profile changed concurrently');
    this.name = 'CredentialProfileConflictError';
  }
}

export function credentialProfilePath(selection: CredentialProfileSelection): string {
  assertProfileSelection(selection);
  const credential = resolveAgentSpec(selection.agentId).credential;
  if (!credential) throw new CredentialProfileError(`agent '${selection.agentId}' has no credential`);
  return `agents/${selection.agentId}/profiles/${selection.profileId}/${credential.boxRelPath}`;
}

function legacyCredentialPath(selection: CredentialProfileSelection): string {
  const credential = resolveAgentSpec(selection.agentId).credential;
  if (!credential) throw new CredentialProfileError(`agent '${selection.agentId}' has no credential`);
  return `agents/${selection.agentId}/${credential.boxRelPath}`;
}

function revocationPath(selection: CredentialProfileSelection): string {
  return `agents/${selection.agentId}/profiles/${selection.profileId}/.revoked`;
}

export function assertProfileSelection(selection: CredentialProfileSelection): void {
  if (!AGENT_ID_RE.test(selection.agentId) || !PROFILE_ID_RE.test(selection.profileId)) {
    throw new CredentialProfileError('credential profile agent and profile IDs have invalid syntax');
  }
  try {
    resolveAgentSpec(selection.agentId);
  } catch {
    throw new CredentialProfileError(`unknown credential agent '${selection.agentId}'`);
  }
}

/**
 * Metadata-only facade for named credential records. The legacy single-profile
 * entry is lazily adopted as `default`; values never leave this facade.
 */
export class CredentialProfileStore {
  constructor(private readonly custody: CustodyStore) {}

  async get(selection: CredentialProfileSelection): Promise<CredentialProfileMetadata | null> {
    assertProfileSelection(selection);
    const canonical = await this.custody.stat(credentialProfilePath(selection));
    const revoked = await this.custody.stat(revocationPath(selection));
    if (canonical) return this.metadata(selection, canonical, revoked ? 'revoked' : 'active');
    if (selection.profileId !== DEFAULT_CREDENTIAL_PROFILE_ID) return null;
    const legacy = await this.custody.stat(legacyCredentialPath(selection));
    return legacy ? this.metadata(selection, legacy, revoked ? 'revoked' : 'active') : null;
  }

  async list(agentId?: string): Promise<CredentialProfileMetadata[]> {
    if (agentId !== undefined) assertProfileSelection({ agentId, profileId: DEFAULT_CREDENTIAL_PROFILE_ID });
    const entries = await this.custody.list(agentId ? `agents/${agentId}` : 'agents');
    const profiles = new Map<string, CredentialProfileMetadata>();
    for (const entry of entries) {
      const parts = entry.path.split('/');
      if (parts[0] !== 'agents' || !parts[1]) continue;
      const agent = parts[1];
      const profile = parts[2] === 'profiles' ? parts[3] : DEFAULT_CREDENTIAL_PROFILE_ID;
      if (!profile) continue;
      const selection = { agentId: agent, profileId: profile };
      try {
        assertProfileSelection(selection);
      } catch {
        continue;
      }
      const canonicalPath = credentialProfilePath(selection);
      const legacyPath = legacyCredentialPath(selection);
      // A profile directory can hold revocation metadata or future internals;
      // only its exact declared credential location is a profile record.
      if (entry.path !== canonicalPath && entry.path !== legacyPath) continue;
      const key = `${agent}:${profile}`;
      // A canonical default takes precedence over the compatibility entry.
      if (entry.path === legacyPath && profiles.has(key)) continue;
      const revoked = await this.custody.stat(revocationPath(selection));
      profiles.set(key, this.metadata(selection, entry, revoked ? 'revoked' : 'active'));
    }
    return [...profiles.values()].sort((a, b) =>
      a.agentId === b.agentId ? a.profileId.localeCompare(b.profileId) : a.agentId.localeCompare(b.agentId),
    );
  }

  async update(
    selection: CredentialProfileSelection,
    data: Buffer,
    expectedSha256?: string,
  ): Promise<CredentialProfileMetadata> {
    assertProfileSelection(selection);
    return this.withLock(selection, async () => {
      const path = credentialProfilePath(selection);
      const current = await this.get(selection);
      if (expectedSha256 !== undefined && current?.sha256 !== expectedSha256) {
        throw new CredentialProfileConflictError();
      }
      // Lazy migration is deliberately write-before-delete: a crash leaves the
      // legacy default usable and a retry is content-addressed/idempotent.
      const result = await this.custody.put(path, data);
      await this.custody.delete(revocationPath(selection));
      return this.metadata(selection, result, 'active');
    });
  }

  async revoke(selection: CredentialProfileSelection, expectedSha256?: string): Promise<CredentialProfileMetadata> {
    assertProfileSelection(selection);
    return this.withLock(selection, async () => {
      const current = await this.get(selection);
      if (!current) throw new CredentialProfileError('credential profile not found');
      if (expectedSha256 !== undefined && current.sha256 !== expectedSha256) {
        throw new CredentialProfileConflictError();
      }
      // Keep the credential record intact: revocation must be durable metadata and
      // cannot be undone by a lazy default migration from the legacy location.
      await this.custody.put(revocationPath(selection), Buffer.from('revoked', 'utf8'));
      return { ...current, health: 'revoked' };
    });
  }

  private async withLock<T>(
    selection: CredentialProfileSelection,
    operation: () => Promise<T>,
  ): Promise<T> {
    const locking = this.custody as CustodyStore & {
      withProfileLock?: <R>(key: string, callback: () => Promise<R>) => Promise<R>;
    };
    return locking.withProfileLock
      ? locking.withProfileLock(`${selection.agentId}/${selection.profileId}`, operation)
      : operation();
  }

  private metadata(
    selection: CredentialProfileSelection,
    entry: CustodyEntry,
    health: CredentialProfileHealth,
  ): CredentialProfileMetadata {
    return { agentId: selection.agentId, profileId: selection.profileId, health, sha256: entry.sha256, size: entry.size, updatedAt: entry.updatedAt };
  }
}
