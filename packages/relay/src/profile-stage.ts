import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CredentialProfileSelection, SyncTransport } from '@agentbox/core';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { CredentialProfileStore } from './custody/profiles.js';

export class ProfileStageError extends Error {
  constructor(readonly code: 'profile_unavailable' | 'profile_revoked' | 'profile_reauth_required' | 'profile_stage_failed') {
    super(code);
    this.name = 'ProfileStageError';
  }
}

/**
 * AgentBox-owned selected-profile staging. Credential bytes exist only in a
 * mode-0600 temporary file while SyncTransport transfers them to the declared
 * credential destination; neither callers nor box metadata receive the bytes.
 */
export async function stageCredentialProfile(
  profiles: CredentialProfileStore,
  transport: SyncTransport,
  selection: CredentialProfileSelection,
): Promise<void> {
  const metadata = await profiles.get(selection);
  if (!metadata) throw new ProfileStageError('profile_unavailable');
  if (metadata.health !== 'active') throw new ProfileStageError('profile_revoked');
  if (await profiles.reauthenticationRequest(selection)) throw new ProfileStageError('profile_reauth_required');
  const credential = resolveAgentSpec(selection.agentId).credential;
  if (!credential) throw new ProfileStageError('profile_unavailable');
  const bytes = await profiles.readForStage(selection);
  if (!bytes) throw new ProfileStageError('profile_unavailable');

  const dir = await mkdtemp(join(tmpdir(), 'agentbox-profile-stage-'));
  const file = join(dir, 'credential');
  try {
    await writeFile(file, bytes, { mode: 0o600 });
    await chmod(file, 0o600);
    await transport.pushFile(file, credential.boxAbsPath, { mode: 0o600 });
    // Recheck immediately before launch: a revoke/reauth/CAS update racing the
    // transfer must block tmux rather than launching a stale credential.
    const after = await profiles.get(selection);
    if (!after || after.health !== 'active' || after.sha256 !== metadata.sha256 || await profiles.reauthenticationRequest(selection)) {
      throw new ProfileStageError('profile_stage_failed');
    }
  } catch {
    throw new ProfileStageError('profile_stage_failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
