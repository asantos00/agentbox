import type { BoxRecord, CredentialProfileSelection } from '@agentbox/core';

export interface StructuredProfilePropagationDeps {
  dockerVolume(box: BoxRecord): string;
  writeDocker(input: {
    volume: string;
    image: string;
    credentialPath: string;
    content: string;
    mode: number;
  }): Promise<void>;
  dockerRunning(box: BoxRecord): Promise<boolean>;
  cloudRunning(box: BoxRecord): Promise<boolean>;
  stageCloud(box: BoxRecord): Promise<void>;
  shouldIngest(agentId: string, credentialAgentId: string): boolean;
  ingestDocker(box: BoxRecord, agentId: string): Promise<void>;
  ingestCloud(box: BoxRecord, agentId: string): Promise<void>;
}

export interface StructuredProfilePropagationResult {
  matched: number;
  staged: number;
  skipped: number;
  failed: number;
}

function hasExactProfile(box: BoxRecord, selection: CredentialProfileSelection): boolean {
  return (box.credentialProfiles ?? []).some(
    (profile) => profile.agentId === selection.agentId && profile.profileId === selection.profileId,
  );
}

async function ingestMatching(
  box: BoxRecord,
  selection: CredentialProfileSelection,
  ingest: (box: BoxRecord, agentId: string) => Promise<void>,
  deps: StructuredProfilePropagationDeps,
): Promise<void> {
  for (const agentId of box.agents ?? []) {
    if (deps.shouldIngest(agentId, selection.agentId)) await ingest(box, agentId);
  }
}

/**
 * Executes exact-profile fanout without any access to legacy backups or global
 * custody paths. All effects are injected so profile isolation can be proven
 * without credentials, Docker, or provider access.
 */
export async function propagateStructuredProfileWithDeps(input: {
  selection: CredentialProfileSelection;
  sourceBoxId?: string;
  boxes: BoxRecord[];
  credentialPath: string;
  content: string;
  defaultImage: string;
  deps: StructuredProfilePropagationDeps;
}): Promise<StructuredProfilePropagationResult> {
  const { selection, sourceBoxId, credentialPath, content, defaultImage, deps } = input;
  const targets = input.boxes.filter(
    (box) => box.id !== sourceBoxId && hasExactProfile(box, selection),
  );
  let staged = 0;
  let skipped = 0;
  let failed = 0;

  const dockerVolumes = new Map<string, { image: string; boxes: BoxRecord[] }>();
  for (const box of targets) {
    if ((box.provider ?? 'docker') !== 'docker') continue;
    const volume = deps.dockerVolume(box);
    const existing = dockerVolumes.get(volume);
    if (existing) existing.boxes.push(box);
    else dockerVolumes.set(volume, { image: box.image || defaultImage, boxes: [box] });
  }

  for (const [volume, target] of dockerVolumes) {
    try {
      await deps.writeDocker({ volume, image: target.image, credentialPath, content, mode: 0o600 });
      staged += 1;
      for (const box of target.boxes) {
        if (!(await deps.dockerRunning(box))) {
          skipped += 1;
          continue;
        }
        await ingestMatching(box, selection, deps.ingestDocker, deps);
      }
    } catch {
      failed += 1;
    }
  }

  for (const box of targets) {
    if ((box.provider ?? 'docker') === 'docker') continue;
    try {
      if (!(await deps.cloudRunning(box))) {
        skipped += 1;
        continue;
      }
      await deps.stageCloud(box);
      staged += 1;
      await ingestMatching(box, selection, deps.ingestCloud, deps);
    } catch {
      failed += 1;
    }
  }

  return { matched: targets.length, staged, skipped, failed };
}
