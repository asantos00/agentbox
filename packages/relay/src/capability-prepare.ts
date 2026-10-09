import type { BoxRegistration } from './types.js';

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

/** Server-attested target. No field in this proof is accepted from the request. */
export interface CapabilityTargetProof {
  boxId: string;
  standingSlotId: string;
  environment: 'non-production';
  approved: true;
  endpoint: { backend: string; sandboxId: string };
}

export interface ApprovedCapabilityProfile {
  readonly id: string;
  readonly capabilities: string[];
  prepare(
    target: CapabilityTargetProof,
    operationTag: string,
  ): Promise<CapabilityPreparationOutcome>;
  reconcile(
    target: CapabilityTargetProof,
    operationTag: string,
  ): Promise<
    | { state: 'completed'; result: CapabilityPreparationOutcome }
    | { state: 'absent' }
    | { state: 'unreconcilable'; reason: string }
  >;
}

export interface CapabilityProfileRegistry {
  resolve(capabilityProfileId: string): Promise<ApprovedCapabilityProfile | null>;
}

export interface CapabilityTargetVerifier {
  verify(registration: BoxRegistration): Promise<CapabilityTargetProof | null>;
}

export interface CapabilityPreparationService {
  profiles: CapabilityProfileRegistry;
  targets: CapabilityTargetVerifier;
}

export function capabilityTargetMatchesRegistration(
  target: CapabilityTargetProof,
  registration: BoxRegistration,
): boolean {
  return (
    target.approved === true &&
    target.environment === 'non-production' &&
    target.boxId === registration.boxId &&
    registration.kind === 'cloud' &&
    typeof registration.backend === 'string' &&
    registration.backend === target.endpoint.backend &&
    typeof registration.sandboxId === 'string' &&
    registration.sandboxId === target.endpoint.sandboxId
  );
}
