import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { SyncTransport } from '@agentbox/core';
import {
  canonicalOrchestratorBootstrap,
  ORCHESTRATOR_BOOTSTRAP_PATH,
  stageOrchestratorBootstrap,
} from '../lib/orchestrator-bootstrap.js';

const now = Date.parse('2026-10-19T18:00:00.000Z');
const raw = JSON.stringify({
  version: 1,
  controller: 'https://controller.example.test/v1/worker/',
  capability: 'a'.repeat(64),
  expiresAt: '2026-10-20T18:00:00.000Z',
  protocol: {
    context: 'POST /v1/worker/context',
    events: 'POST /v1/worker/events/{action}',
    settle: 'POST /v1/worker/settle',
  },
});

describe('orchestrator worker bootstrap', () => {
  it('validates and stages the capability through a private file, not argv', async () => {
    const canonical = canonicalOrchestratorBootstrap(raw, now);
    let staged: { destination: string; contents: string; mode?: number; uid?: number } | undefined;
    const transport = {
      caps: { persistentVolumes: false, helperContainer: false, ephemeralFs: true },
      pushFile: async (
        source: string,
        destination: string,
        options?: { mode?: number; uid?: number },
      ) => {
        staged = {
          destination,
          contents: await readFile(source, 'utf8'),
          mode: options?.mode,
          uid: options?.uid,
        };
      },
      readText: async (path: string) => (staged?.destination === path ? staged.contents : null),
    } as unknown as SyncTransport;

    await stageOrchestratorBootstrap(transport, canonical);

    expect(staged).toEqual({
      destination: ORCHESTRATOR_BOOTSTRAP_PATH,
      contents: canonical,
      mode: 0o600,
      uid: 1000,
    });
  });

  it('stages and verifies a tailnet controller host mapping inside the box', async () => {
    const canonical = canonicalOrchestratorBootstrap(
      raw.replace('controller.example.test', 'controller.tailnet.ts.net'),
      now,
    );
    let staged: string | undefined;
    const commands: Array<{ command: string[]; user?: string }> = [];
    const transport = {
      caps: { persistentVolumes: false, helperContainer: false, ephemeralFs: true },
      pushFile: async (source: string) => {
        staged = await readFile(source, 'utf8');
      },
      readText: async () => staged ?? null,
      exec: async (command: string[], options?: { user?: string }) => {
        commands.push({ command, user: options?.user });
        return command[0] === 'getent'
          ? { exitCode: 0, stdout: '100.85.140.42 controller.tailnet.ts.net\n', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
    } as unknown as SyncTransport;

    await stageOrchestratorBootstrap(transport, canonical, async () => ({
      address: '100.85.140.42',
    }));

    expect(commands).toHaveLength(2);
    expect(commands[0]?.user).toBe('root');
    expect(commands[0]?.command).toContain('controller.tailnet.ts.net');
    expect(commands[0]?.command).toContain('100.85.140.42');
    expect(commands[1]?.command).toEqual(['getent', 'hosts', 'controller.tailnet.ts.net']);
  });

  it('rejects malformed, expired, and open-ended bootstrap documents', () => {
    expect(() => canonicalOrchestratorBootstrap('{}', now)).toThrow(/invalid/);
    expect(() =>
      canonicalOrchestratorBootstrap(raw.replace('2026-10-20', '2026-10-18'), now),
    ).toThrow(/invalid/);
    expect(() =>
      canonicalOrchestratorBootstrap(
        JSON.stringify({ ...JSON.parse(raw), command: 'curl secret.example' }),
        now,
      ),
    ).toThrow(/invalid/);
  });
});
