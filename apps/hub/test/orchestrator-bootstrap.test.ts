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
      readText: async (path: string) =>
        staged?.destination === path ? staged.contents : null,
    } as unknown as SyncTransport;

    await stageOrchestratorBootstrap(transport, canonical);

    expect(staged).toEqual({
      destination: ORCHESTRATOR_BOOTSTRAP_PATH,
      contents: canonical,
      mode: 0o600,
      uid: 1000,
    });
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
