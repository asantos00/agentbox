import { createHash, createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  CredentialProfileStore,
  type CustodyStore,
  type ProfileUsageHelper,
} from '@agentbox/relay';

const execFileAsync = promisify(execFile);
const CODEXBAR_MAX_BYTES = 1024 * 1024;

type CodexBarRecord = {
  source?: unknown;
  usage?: {
    loginMethod?: unknown;
    primary?: CodexBarWindow | null;
    secondary?: CodexBarWindow | null;
    tertiary?: CodexBarWindow | null;
    updatedAt?: unknown;
  };
  credits?: { remaining?: unknown };
};

type CodexBarWindow = {
  usedPercent?: unknown;
  resetsAt?: unknown;
};

function window(value: CodexBarWindow | null | undefined) {
  if (!value || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent))
    return [];
  return [
    {
      used: Math.max(0, Math.min(100, value.usedPercent)),
      limit: 100,
      ...(typeof value.resetsAt === 'string' ? { resetAt: value.resetsAt } : {}),
    },
  ];
}

function parse(stdout: string): CodexBarRecord {
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object')
    throw new Error('unexpected CodexBar response');
  return value[0] as CodexBarRecord;
}

function accountIdentity(agentId: 'codex' | 'pi', bytes: Buffer): string | undefined {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (agentId === 'pi') {
    const provider = row['openai-codex'];
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return undefined;
    const accountId = (provider as Record<string, unknown>).accountId;
    return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
  }
  const tokens = row.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return undefined;
  const accountId = (tokens as Record<string, unknown>).account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
}

/**
 * Reads the selected named profile only after proving that its custody digest
 * matches the host Codex credential inspected by CodexBar. Callers can select a
 * profile identity, but cannot supply a path, command, environment, or bearer.
 */
export function createCodexBarProfileUsageHelper(input: {
  custody: CustodyStore;
  fingerprintSecret: string;
  codexAuthPath?: string;
  piAuthPath?: string;
  codexbarBinary?: string;
}): ProfileUsageHelper {
  const profiles = new CredentialProfileStore(input.custody);
  const codexAuthPath = input.codexAuthPath ?? join(homedir(), '.codex', 'auth.json');
  const piAuthPath = input.piAuthPath ?? join(homedir(), '.agentbox', 'pi-credentials.json');
  const binary = input.codexbarBinary ?? '/opt/homebrew/bin/codexbar';
  return {
    async inspect(selection) {
      if (selection.agentId !== 'codex' && selection.agentId !== 'pi')
        return {
          provider: selection.agentId,
          identityMatch: false,
          windows: [],
          status: 'unavailable',
          reauthRequired: false,
          source: 'codexbar',
          observedAt: new Date().toISOString(),
          freshness: 'unavailable',
          confidence: 'unavailable',
          errorCode: 'provider_unsupported',
        };
      const selectedAuthPath = selection.agentId === 'pi' ? piAuthPath : codexAuthPath;
      const [profile, selectedAuth, codexAuth] = await Promise.all([
        profiles.get(selection),
        readFile(selectedAuthPath),
        readFile(codexAuthPath),
      ]);
      const digest = createHash('sha256').update(selectedAuth).digest('hex');
      const accountId = accountIdentity(selection.agentId, selectedAuth);
      const codexAccountId = accountIdentity('codex', codexAuth);
      if (!profile || profile.sha256 !== digest || !accountId || accountId !== codexAccountId)
        return {
          provider: 'codex',
          identityMatch: false,
          windows: [],
          status: 'identity-mismatch',
          reauthRequired: true,
          source: 'codexbar',
          observedAt: new Date().toISOString(),
          freshness: 'exact',
          confidence: 'exact',
          errorCode: 'credential_digest_mismatch',
        };
      const { stdout } = await execFileAsync(
        binary,
        ['usage', '--provider', 'codex', '--json', '--no-credits'],
        {
          encoding: 'utf8',
          timeout: 15_000,
          maxBuffer: CODEXBAR_MAX_BYTES,
          windowsHide: true,
        },
      );
      const record = parse(stdout);
      const usage = record.usage;
      const observedAt =
        typeof usage?.updatedAt === 'string' ? usage.updatedAt : new Date().toISOString();
      const plan =
        typeof usage?.loginMethod === 'string'
          ? usage.loginMethod.replace(/[^A-Za-z0-9._:-]/g, '')
          : undefined;
      const credits = record.credits?.remaining;
      return {
        provider: 'codex',
        providerIdentityFingerprint: `hmac-sha256:${createHmac('sha256', input.fingerprintSecret)
          .update(`${selection.agentId}\0${selection.profileId}\0${accountId}`)
          .digest('hex')}`,
        identityMatch: true,
        windows: [
          ...window(usage?.primary),
          ...window(usage?.secondary),
          ...window(usage?.tertiary),
        ],
        ...(plan ? { plan } : {}),
        ...(typeof credits === 'number' && Number.isFinite(credits) && credits >= 0
          ? { credits }
          : {}),
        status: 'active',
        reauthRequired: false,
        source: typeof record.source === 'string' ? `codexbar-${record.source}` : 'codexbar',
        observedAt,
        freshness: 'exact',
        confidence: 'exact',
      };
    },
  };
}
