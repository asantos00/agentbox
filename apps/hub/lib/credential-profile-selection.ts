import { modelAuthSourceId, type AgentSyncSpec } from '@agentbox/core';

export interface CredentialProfileSelection {
  agentId: string;
  profileId: string;
}

const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Validate the metadata selection before any provider operation. */
export function validateCredentialProfileSelections(
  runtimeAgent: AgentSyncSpec | undefined,
  selections: readonly CredentialProfileSelection[],
): void {
  if (selections.length > 0 && !runtimeAgent) {
    throw new Error('credential profiles require a runtime agent');
  }
  const selectedAgents = new Set<string>();
  for (const selection of selections) {
    if (!AGENT_ID_RE.test(selection.agentId) || !PROFILE_ID_RE.test(selection.profileId)) {
      throw new Error('credential profile selection has invalid identifiers');
    }
    if (selectedAgents.has(selection.agentId)) {
      throw new Error('credential profile selection names more than one profile for an agent');
    }
    selectedAgents.add(selection.agentId);
    const allowed =
      (selection.agentId === runtimeAgent!.id && runtimeAgent!.credential !== undefined) ||
      runtimeAgent!.modelAuth?.sources.some(
        (source) => source.kind === 'agent' && modelAuthSourceId(source) === selection.agentId,
      );
    if (!allowed)
      throw new Error('credential profile is not a declared credential source for this agent');
  }
}
