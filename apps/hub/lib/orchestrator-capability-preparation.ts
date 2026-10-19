import type { CloudBackend } from '@agentbox/core';
import type {
  ApprovedCapabilityProfile,
  CapabilityPreparationOutcome,
  CapabilityPreparationService,
  CapabilityTargetProof,
  BoxRegistration,
} from '@agentbox/relay';

interface BackendResolver {
  resolveBackend(name: string): Promise<CloudBackend | null>;
}

function failed(profileId: string, operationTag: string): CapabilityPreparationOutcome {
  return {
    status: 'failed',
    capabilityProfileId: profileId,
    capabilities: ['node'],
    providerMutationId: operationTag,
    readiness: {
      ready: false,
      checks: [{ id: 'node-runtime', status: 'failed' }],
      observedAt: new Date().toISOString(),
    },
    cleanup: { attempted: false, succeeded: false },
    failure: 'readiness_failed',
  };
}

async function observeNode(
  resolver: BackendResolver,
  target: CapabilityTargetProof,
  operationTag: string,
): Promise<CapabilityPreparationOutcome> {
  const backend = await resolver.resolveBackend(target.endpoint.backend);
  if (!backend || backend.name !== target.endpoint.backend) return failed('node', operationTag);
  const handle = await backend.get(target.endpoint.sandboxId);
  if (!handle || handle.sandboxId !== target.endpoint.sandboxId)
    return failed('node', operationTag);
  const result = await backend.exec(handle, 'node --version && npm --version');
  const ready = result.exitCode === 0;
  return ready
    ? {
        status: 'ready',
        capabilityProfileId: 'node',
        capabilities: ['node'],
        providerMutationId: operationTag,
        readiness: {
          ready: true,
          checks: [{ id: 'node-runtime', status: 'passed' }],
          observedAt: new Date().toISOString(),
        },
        cleanup: { attempted: false, succeeded: false },
      }
    : failed('node', operationTag);
}

/** Closed non-production catalog used by the local orchestrator Hub. */
export function createOrchestratorCapabilityPreparation(input: {
  resolver: BackendResolver;
  backend: string;
  boxNamePrefix: string;
  resolveRegistration?: (boxId: string) => Promise<BoxRegistration | null>;
}): CapabilityPreparationService {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.backend))
    throw new Error('invalid capability backend');
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(input.boxNamePrefix))
    throw new Error('invalid capability box prefix');

  const node: ApprovedCapabilityProfile = {
    id: 'node',
    capabilities: ['node'],
    prepare: (target, operationTag) => observeNode(input.resolver, target, operationTag),
    reconcile: async (target, operationTag) => {
      const result = await observeNode(input.resolver, target, operationTag);
      return result.status === 'ready' ? { state: 'completed', result } : { state: 'absent' };
    },
  };

  return {
    ...(input.resolveRegistration ? { registrations: { resolve: input.resolveRegistration } } : {}),
    profiles: {
      resolve: async (id) => (id === node.id ? node : null),
    },
    targets: {
      verify: async (registration: BoxRegistration) => {
        if (
          registration.kind !== 'cloud' ||
          registration.backend !== input.backend ||
          typeof registration.sandboxId !== 'string' ||
          registration.sandboxId.length === 0 ||
          !registration.name.startsWith(input.boxNamePrefix)
        )
          return null;
        return {
          boxId: registration.boxId,
          standingSlotId: `orchestrator:${registration.boxId}`,
          environment: 'non-production',
          approved: true,
          endpoint: {
            backend: registration.backend,
            sandboxId: registration.sandboxId,
          },
        };
      },
    },
  };
}
