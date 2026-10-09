import type { CredentialProfileSelection } from '@agentbox/core';
import { CredentialProfileStore } from './custody/profiles.js';
import type { ProfileLifecycle } from './profile-lifecycle.js';

export type ProfileUsageStatus = 'active' | 'revoked' | 'reauth-required' | 'identity-mismatch' | 'unavailable';
export type ProfileUsageFreshness = 'exact' | 'stale' | 'unavailable';
export type ProfileUsageConfidence = 'exact' | 'inferred' | 'unavailable';

export interface ProfileUsageWindow {
  used?: number;
  limit?: number;
  resetAt?: string;
}

/** The intentionally small, metadata-only result available to the orchestrator. */
export interface ProfileUsageMetadata {
  version: 1;
  agentId: string;
  profileId: string;
  provider: string;
  providerIdentityFingerprint?: string;
  identityMatch: boolean;
  windows: ProfileUsageWindow[];
  plan?: string;
  credits?: number;
  status: ProfileUsageStatus;
  reauthRequired: boolean;
  source: string;
  observedAt: string;
  freshness: ProfileUsageFreshness;
  confidence: ProfileUsageConfidence;
  errorCode?: string;
}

/**
 * This runs under the AgentBox credential owner. Its implementation resolves
 * the selected isolated home itself; callers deliberately cannot supply one.
 */
export interface ProfileUsageHelper {
  inspect(selection: CredentialProfileSelection): Promise<Omit<ProfileUsageMetadata, 'version' | 'agentId' | 'profileId'>>;
}

const UNAVAILABLE: Omit<ProfileUsageMetadata, 'version' | 'agentId' | 'profileId'> = {
  provider: 'unknown',
  identityMatch: false,
  windows: [],
  status: 'unavailable',
  reauthRequired: false,
  source: 'agentbox',
  observedAt: new Date(0).toISOString(),
  freshness: 'unavailable',
  confidence: 'unavailable',
  errorCode: 'profile_usage_unavailable',
};

/**
 * Gates profile inspection before a helper can run and coalesces concurrent
 * reads per profile. The helper receives only a stable selection, never a path,
 * command, environment, or credential value.
 */
export class ProfileUsageService {
  private readonly pending = new Map<string, Promise<ProfileUsageMetadata>>();

  constructor(
    private readonly profiles: CredentialProfileStore,
    private readonly helper: ProfileUsageHelper | null,
    private readonly lifecycle?: ProfileLifecycle,
    private readonly helperTimeoutMs = 5_000,
  ) {}

  get(selection: CredentialProfileSelection): Promise<ProfileUsageMetadata> {
    const key = `${selection.agentId}\u0000${selection.profileId}`;
    const current = this.pending.get(key);
    if (current) return current;
    const request = this.inspect(selection).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private async inspect(selection: CredentialProfileSelection): Promise<ProfileUsageMetadata> {
    const profile = await this.profiles.get(selection);
    if (!profile) return this.unavailable(selection, 'profile_unavailable');
    if (profile.health === 'revoked') return this.unavailable(selection, 'profile_revoked', 'revoked');
    if (await this.profiles.reauthenticationRequest(selection)) return this.unavailable(selection, 'reauth_required', 'reauth-required');
    if (!this.helper) return this.unavailable(selection, 'profile_usage_unavailable');
    try {
      await this.lifecycle?.materialize(selection);
      const result = await boundedHelper(this.helper.inspect(selection), this.helperTimeoutMs);
      // Never trust a helper's selection echo or free-form status. Identity
      // mismatch is terminal for staging/quota until an operator reauthenticates.
      const identityMatch = result.identityMatch === true;
      const status: ProfileUsageStatus = identityMatch ? result.status : 'identity-mismatch';
      return {
        version: 1,
        agentId: selection.agentId,
        profileId: selection.profileId,
        provider: safeMetadata(result.provider, 'unknown'),
        ...(result.providerIdentityFingerprint ? { providerIdentityFingerprint: safeMetadata(result.providerIdentityFingerprint, '') } : {}),
        identityMatch,
        windows: normalizeWindows(result.windows),
        ...(result.plan ? { plan: safeMetadata(result.plan, '') } : {}),
        ...(typeof result.credits === 'number' && Number.isFinite(result.credits) && result.credits >= 0 ? { credits: result.credits } : {}),
        status: allowedStatus(status),
        reauthRequired: result.reauthRequired === true || !identityMatch,
        source: safeMetadata(result.source, 'agentbox'),
        observedAt: validTime(result.observedAt),
        freshness: allowedFreshness(result.freshness),
        confidence: allowedConfidence(result.confidence),
        ...(result.errorCode ? { errorCode: boundedCode(result.errorCode) } : {}),
      };
    } catch {
      return this.unavailable(selection, 'profile_usage_failed');
    } finally {
      await this.lifecycle?.cleanup(selection);
    }
  }

  private unavailable(
    selection: CredentialProfileSelection,
    errorCode: string,
    status: ProfileUsageStatus = 'unavailable',
  ): ProfileUsageMetadata {
    return { ...UNAVAILABLE, version: 1, agentId: selection.agentId, profileId: selection.profileId, status, reauthRequired: status === 'revoked' || status === 'reauth-required', errorCode };
  }
}

function normalizeWindows(windows: ProfileUsageWindow[]): ProfileUsageWindow[] {
  if (!Array.isArray(windows)) return [];
  return windows.slice(0, 8).flatMap((window) => {
    if (!window || typeof window !== 'object') return [];
    const out: ProfileUsageWindow = {};
    if (typeof window.used === 'number' && Number.isFinite(window.used) && window.used >= 0) out.used = window.used;
    if (typeof window.limit === 'number' && Number.isFinite(window.limit) && window.limit >= 0) out.limit = window.limit;
    if (typeof window.resetAt === 'string') out.resetAt = validTime(window.resetAt);
    return [out];
  });
}

function safeMetadata(value: string, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : fallback;
}
function allowedStatus(value: unknown): ProfileUsageStatus { return value === 'active' || value === 'revoked' || value === 'reauth-required' || value === 'identity-mismatch' || value === 'unavailable' ? value : 'unavailable'; }
function allowedFreshness(value: unknown): ProfileUsageFreshness { return value === 'exact' || value === 'stale' || value === 'unavailable' ? value : 'unavailable'; }
function allowedConfidence(value: unknown): ProfileUsageConfidence { return value === 'exact' || value === 'inferred' || value === 'unavailable' ? value : 'unavailable'; }
async function boundedHelper<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), Math.max(1, Math.min(timeoutMs, 30_000))); timer.unref(); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function boundedCode(value: string): string {
  return /^[a-z0-9_-]{1,64}$/.test(value) ? value : 'profile_usage_failed';
}
function validTime(value: string): string {
  return Number.isNaN(Date.parse(value)) ? new Date(0).toISOString() : new Date(value).toISOString();
}
