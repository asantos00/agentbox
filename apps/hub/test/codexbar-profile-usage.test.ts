import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialProfileStore, FsCustodyStore } from '@agentbox/relay';
import { createCodexBarProfileUsageHelper } from '../lib/codexbar-profile-usage';

describe('CodexBar profile usage helper', () => {
  let root: string;
  let authPath: string;
  let binary: string;
  let custody: FsCustodyStore;
  let profiles: CredentialProfileStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentbox-codexbar-'));
    authPath = join(root, 'auth.json');
    binary = join(root, 'codexbar');
    custody = new FsCustodyStore({ root: join(root, 'custody') });
    profiles = new CredentialProfileStore(custody);
    await writeFile(authPath, '{"tokens":{"account_id":"account-fixture"}}', { mode: 0o600 });
    await writeFile(
      binary,
      `#!/bin/sh
printf '%s' '[{"usage":{"loginMethod":"pro","primary":{"usedPercent":12,"resetsAt":"2026-10-20T00:00:00Z"},"secondary":null,"tertiary":null,"updatedAt":"2026-10-19T00:00:00Z"},"source":"oauth","credits":{"remaining":42}}]'
`,
    );
    await chmod(binary, 0o700);
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('returns bounded metadata only when the selected profile matches the live Codex identity', async () => {
    await profiles.update({ agentId: 'codex', profileId: 'personal' }, await readFile(authPath));
    const helper = createCodexBarProfileUsageHelper({
      custody,
      fingerprintSecret: 'fixture-secret',
      codexAuthPath: authPath,
      codexbarBinary: binary,
    });

    await expect(
      helper.inspect({ agentId: 'codex', profileId: 'personal' }),
    ).resolves.toMatchObject({
      provider: 'codex',
      identityMatch: true,
      windows: [{ used: 12, limit: 100, resetAt: '2026-10-20T00:00:00Z' }],
      plan: 'pro',
      credits: 42,
      status: 'active',
      source: 'codexbar-oauth',
    });
  });

  it('maps a Pi profile only when its provider identity matches CodexBar', async () => {
    const piAuthPath = join(root, 'pi-auth.json');
    await writeFile(piAuthPath, '{"openai-codex":{"accountId":"account-fixture"}}', {
      mode: 0o600,
    });
    await profiles.update({ agentId: 'pi', profileId: 'personal' }, await readFile(piAuthPath));
    const helper = createCodexBarProfileUsageHelper({
      custody,
      fingerprintSecret: 'fixture-secret',
      codexAuthPath: authPath,
      piAuthPath,
      codexbarBinary: binary,
    });

    await expect(helper.inspect({ agentId: 'pi', profileId: 'personal' })).resolves.toMatchObject({
      provider: 'codex',
      identityMatch: true,
      status: 'active',
    });
  });

  it('fails closed before CodexBar when custody does not match the live credential', async () => {
    await profiles.update({ agentId: 'codex', profileId: 'personal' }, Buffer.from('different'));
    const helper = createCodexBarProfileUsageHelper({
      custody,
      fingerprintSecret: 'fixture-secret',
      codexAuthPath: authPath,
      codexbarBinary: join(root, 'missing-codexbar'),
    });

    await expect(
      helper.inspect({ agentId: 'codex', profileId: 'personal' }),
    ).resolves.toMatchObject({
      identityMatch: false,
      status: 'identity-mismatch',
      errorCode: 'credential_digest_mismatch',
    });
  });
});
