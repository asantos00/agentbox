import type { CloudBackend, CloudHandle } from '@agentbox/core';

export interface CapabilityReadiness {
  ready: boolean;
  checks: Array<{ id: string; status: 'passed' | 'failed' }>;
  observedAt: string;
}

export interface CapabilityPreparationOutcome {
  status: 'ready' | 'failed';
  capabilityProfileId: string;
  capabilities: string[];
  providerMutationId: string;
  readiness: CapabilityReadiness;
  cleanup: { attempted: boolean; succeeded: boolean };
  failure?: 'preparation_failed' | 'readiness_failed';
}

export interface ApprovedCloudCapabilityTarget {
  boxId: string;
  standingSlotId: string;
  environment: 'non-production';
  approved: true;
  endpoint: { backend: string; sandboxId: string };
}

export type CapabilityPreparationBackend = Pick<
  CloudBackend,
  'name' | 'exec' | 'uploadFile' | 'listFiles'
>;

export interface ReviewedCloudCapabilityContext {
  /** Existing-box IO only: no provision, lifecycle, routes, firewall, or resize hooks. */
  backend: CapabilityPreparationBackend;
  handle: CloudHandle;
  target: ApprovedCloudCapabilityTarget;
  operationTag: string;
}

/**
 * A profile is executable code registered by the AgentBox host, not request
 * data. Keeping the reviewed action behind these callbacks means this seam can
 * never turn a request string into a shell command, image, route, or provider
 * mutation.
 */
export interface ReviewedCloudCapabilityProfile {
  id: string;
  capabilities: string[];
  prepare(
    context: ReviewedCloudCapabilityContext,
  ): Promise<{ providerMutationId: string } | { failure: 'preparation_failed' }>;
  observe(
    context: ReviewedCloudCapabilityContext,
  ): Promise<
    | { state: 'absent' }
    | { state: 'prepared'; providerMutationId: string }
    | { state: 'unreconcilable'; reason: string }
  >;
  readiness(context: ReviewedCloudCapabilityContext): Promise<CapabilityReadiness>;
  cleanup?(context: ReviewedCloudCapabilityContext): Promise<void>;
}

export type CloudCapabilityReconcileResult =
  | { state: 'completed'; result: CapabilityPreparationOutcome }
  | { state: 'absent' }
  | { state: 'unreconcilable'; reason: string };

export type PrepareCloudCapabilityResult =
  | CapabilityPreparationOutcome
  | CloudCapabilityReconcileResult;

function assertTarget(input: {
  backend: CloudBackend;
  target: ApprovedCloudCapabilityTarget;
}): void {
  if (input.target.approved !== true || input.target.environment !== 'non-production') {
    throw new Error('capability target is not an approved non-production standing slot');
  }
  if (input.target.endpoint.backend !== input.backend.name) {
    throw new Error(
      `capability endpoint backend mismatch: attested ${input.target.endpoint.backend}, resolved ${input.backend.name}`,
    );
  }
}

async function contextFor(input: {
  backend: CloudBackend;
  target: ApprovedCloudCapabilityTarget;
  operationTag: string;
}): Promise<ReviewedCloudCapabilityContext> {
  assertTarget(input);
  const handle = await input.backend.get(input.target.endpoint.sandboxId);
  if (!handle) {
    throw new Error(`approved capability target ${input.target.boxId} does not exist`);
  }
  if (handle.sandboxId !== input.target.endpoint.sandboxId) {
    throw new Error(
      `capability endpoint mismatch: attested ${input.target.endpoint.sandboxId}, resolved ${handle.sandboxId}`,
    );
  }
  return { backend: input.backend, handle, target: input.target, operationTag: input.operationTag };
}

async function cleanup(
  profile: ReviewedCloudCapabilityProfile,
  context: ReviewedCloudCapabilityContext,
): Promise<{ attempted: boolean; succeeded: boolean }> {
  if (!profile.cleanup) return { attempted: false, succeeded: false };
  try {
    await profile.cleanup(context);
    return { attempted: true, succeeded: true };
  } catch {
    return { attempted: true, succeeded: false };
  }
}

async function outcomeFor(
  profile: ReviewedCloudCapabilityProfile,
  context: ReviewedCloudCapabilityContext,
  providerMutationId: string,
): Promise<CapabilityPreparationOutcome> {
  const readiness = await profile.readiness(context);
  if (readiness.ready) {
    return {
      status: 'ready',
      capabilityProfileId: profile.id,
      capabilities: [...profile.capabilities],
      providerMutationId,
      readiness,
      cleanup: { attempted: false, succeeded: false },
    };
  }
  return {
    status: 'failed',
    capabilityProfileId: profile.id,
    capabilities: [...profile.capabilities],
    providerMutationId,
    readiness,
    cleanup: await cleanup(profile, context),
    failure: 'readiness_failed',
  };
}

export async function prepareCloudCapability(input: {
  backend: CloudBackend;
  target: ApprovedCloudCapabilityTarget;
  profile: ReviewedCloudCapabilityProfile;
  operationTag: string;
  reconcileOnly?: false;
}): Promise<CapabilityPreparationOutcome>;
export async function prepareCloudCapability(input: {
  backend: CloudBackend;
  target: ApprovedCloudCapabilityTarget;
  profile: ReviewedCloudCapabilityProfile;
  operationTag: string;
  reconcileOnly: true;
}): Promise<CloudCapabilityReconcileResult>;
export async function prepareCloudCapability(input: {
  backend: CloudBackend;
  target: ApprovedCloudCapabilityTarget;
  profile: ReviewedCloudCapabilityProfile;
  operationTag: string;
  reconcileOnly?: boolean;
}): Promise<PrepareCloudCapabilityResult> {
  const context = await contextFor(input);
  if (input.reconcileOnly === true) {
    const observed = await input.profile.observe(context);
    if (observed.state === 'absent') return observed;
    if (observed.state === 'unreconcilable') return observed;
    return {
      state: 'completed',
      result: await outcomeFor(input.profile, context, observed.providerMutationId),
    };
  }

  const prepared = await input.profile.prepare(context);
  if ('failure' in prepared) {
    return {
      status: 'failed',
      capabilityProfileId: input.profile.id,
      capabilities: [...input.profile.capabilities],
      providerMutationId: input.operationTag,
      readiness: { ready: false, checks: [], observedAt: new Date().toISOString() },
      cleanup: await cleanup(input.profile, context),
      failure: 'preparation_failed',
    };
  }
  return outcomeFor(input.profile, context, prepared.providerMutationId);
}
