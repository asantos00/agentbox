import { describe, expect, it, vi } from 'vitest';
import type { BoxRecord } from '@agentbox/core';
import {
  propagateStructuredProfileWithDeps,
  type StructuredProfilePropagationDeps,
} from '../src/commands/structured-profile-propagation.js';

const selected = { agentId: 'codex', profileId: 'default' };

function box(
  id: string,
  profileId: string | null,
  provider = 'docker',
  volume = `volume-${id}`,
): BoxRecord {
  return {
    id,
    name: id,
    projectId: 'project',
    workspacePath: '/fixture',
    createdAt: '2026-01-01T00:00:00.000Z',
    provider,
    container: `container-${id}`,
    image: 'fixture-image',
    agentConfigVolumes: { codex: volume },
    agents: ['consumer'],
    ...(profileId === null
      ? {}
      : { credentialProfiles: [{ agentId: 'codex', profileId }] }),
  } as unknown as BoxRecord;
}

function fixture(overrides: Partial<StructuredProfilePropagationDeps> = {}) {
  const writes: Array<{ volume: string; mode: number; content: string }> = [];
  const dockerIngest: string[] = [];
  const cloudIngest: string[] = [];
  const cloudStages: string[] = [];
  const deps: StructuredProfilePropagationDeps = {
    dockerVolume: (target) => target.agentConfigVolumes!.codex!,
    writeDocker: async ({ volume, mode, content }) => { writes.push({ volume, mode, content }); },
    dockerRunning: async () => true,
    cloudRunning: async () => true,
    stageCloud: async (target) => { cloudStages.push(target.id); },
    shouldIngest: (agentId) => agentId === 'consumer',
    ingestDocker: async (target) => { dockerIngest.push(target.id); },
    ingestCloud: async (target) => { cloudIngest.push(target.id); },
    ...overrides,
  };
  return { deps, writes, dockerIngest, cloudIngest, cloudStages };
}

async function run(boxes: BoxRecord[], deps: StructuredProfilePropagationDeps, sourceBoxId?: string) {
  return propagateStructuredProfileWithDeps({
    selection: selected,
    sourceBoxId,
    boxes,
    credentialPath: '.codex/auth.json',
    content: 'SECRET_FIXTURE',
    defaultImage: 'default-image',
    deps,
  });
}

describe('structured credential profile propagation', () => {
  it('isolates structured default, excludes source, and deduplicates Docker volumes', async () => {
    const f = fixture();
    const result = await run([
      box('source', 'default', 'docker', 'shared'),
      box('same-a', 'default', 'docker', 'shared'),
      box('same-b', 'default', 'docker', 'shared'),
      box('other-profile', 'work'),
      box('legacy', null),
    ], f.deps, 'source');

    expect(result).toEqual({ matched: 2, staged: 1, skipped: 0, failed: 0 });
    expect(f.writes).toEqual([{ volume: 'shared', mode: 0o600, content: 'SECRET_FIXTURE' }]);
    expect(f.dockerIngest).toEqual(['same-a', 'same-b']);
  });

  it('stages paused Docker without ingest and skips paused cloud cleanly', async () => {
    const f = fixture({
      dockerRunning: async () => false,
      cloudRunning: async (target) => target.id === 'cloud-running',
    });
    const result = await run([
      box('docker-paused', 'default'),
      box('cloud-paused', 'default', 'daytona'),
      box('cloud-running', 'default', 'daytona'),
    ], f.deps);

    expect(result).toEqual({ matched: 3, staged: 2, skipped: 2, failed: 0 });
    expect(f.writes[0]?.mode).toBe(0o600);
    expect(f.dockerIngest).toEqual([]);
    expect(f.cloudStages).toEqual(['cloud-running']);
    expect(f.cloudIngest).toEqual(['cloud-running']);
  });

  it('reports target failures without leaking content to output hooks', async () => {
    const write = vi.fn(async () => { throw new Error('SECRET_FIXTURE'); });
    const f = fixture({ writeDocker: write });
    const result = await run([box('broken', 'default')], f.deps);

    expect(result).toEqual({ matched: 1, staged: 0, skipped: 0, failed: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('SECRET_FIXTURE');
  });
});
