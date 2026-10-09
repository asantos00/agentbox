import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CredentialProfileSelection } from '@agentbox/core';
import { CredentialProfileConflictError, CredentialProfileStore } from './custody/profiles.js';

export type ProfileRefreshFailure = 'refresh_unsupported' | 'refresh_failed' | 'refresh_timeout' | 'identity_mismatch' | 'profile_revoked' | 'profile_unavailable' | 'profile_changed';

export interface ProfileRefreshHelper {
  refresh(selection: CredentialProfileSelection): Promise<{ data: Buffer; identityMatch: boolean }>;
}

/** Credential-owner lifecycle: the profile selector is the only caller input. */
export class ProfileLifecycle {
  constructor(private readonly profiles: CredentialProfileStore, private readonly homesRoot: string) {}

  /** Server-derived opaque home; never returned from this boundary. */
  private home(selection: CredentialProfileSelection): string {
    return join(this.homesRoot, createHash('sha256').update(`${selection.agentId}\0${selection.profileId}`).digest('hex'));
  }

  async materialize(selection: CredentialProfileSelection): Promise<void> {
    const data = await this.profiles.readForStage(selection);
    if (!data) throw new Error('profile_unavailable');
    const home = this.home(selection);
    await mkdir(this.homesRoot, { recursive: true, mode: 0o700 });
    await chmod(this.homesRoot, 0o700);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    const credential = join(home, 'credential');
    await writeFile(credential, data, { mode: 0o600 });
    await chmod(credential, 0o600);
  }

  async homeModes(selection: CredentialProfileSelection): Promise<{ home: number; credential: number }> {
    const home = this.home(selection);
    const credential = join(home, 'credential');
    return { home: (await stat(home)).mode & 0o777, credential: (await stat(credential)).mode & 0o777 };
  }

  async cleanup(selection: CredentialProfileSelection): Promise<void> {
    await rm(this.home(selection), { recursive: true, force: true });
  }

  async refresh(selection: CredentialProfileSelection, helper: ProfileRefreshHelper | null, timeoutMs = 5_000): Promise<{ ok: true } | { ok: false; code: ProfileRefreshFailure }> {
    const current = await this.profiles.get(selection);
    if (!current) return this.fail(selection, 'profile_unavailable');
    if (current.health !== 'active') return this.fail(selection, 'profile_revoked');
    if (!helper) return this.fail(selection, 'refresh_unsupported');
    try {
      await this.materialize(selection);
      const refreshed = await withTimeout(helper.refresh(selection), timeoutMs);
      if (!refreshed.identityMatch) return this.fail(selection, 'identity_mismatch');
      await this.profiles.update(selection, refreshed.data, current.sha256);
      return { ok: true };
    } catch (error) {
      if (error instanceof CredentialProfileConflictError) return this.fail(selection, 'profile_changed');
      return this.fail(selection, error instanceof TimeoutError ? 'refresh_timeout' : 'refresh_failed');
    } finally {
      // Refresh homes contain only transient execution material. Durable state
      // remains in custody; no caller controls or observes this path.
      await this.cleanup(selection);
    }
  }

  private async fail(selection: CredentialProfileSelection, code: ProfileRefreshFailure): Promise<{ ok: false; code: ProfileRefreshFailure }> {
    await this.profiles.requestReauthentication(selection, code);
    return { ok: false, code };
  }
}

class TimeoutError extends Error {}
async function withTimeout<T>(value: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([value, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new TimeoutError()), ms); timer.unref(); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
