import { describe, expect, it } from 'vitest';
import type { BoxRegistration } from '@agentbox/relay';
import { mapRegistrationToBox, projectBoxAgent } from '../lib/hub-backend';

describe('agentless box projection', () => {
  it('reports absent agent identity as shell for local and registered boxes', () => {
    expect(projectBoxAgent(undefined)).toBe('shell');

    const registration = {
      boxId: 'box-agentless',
      token: 'not-used',
      name: 'managed-warm-slot',
      registeredAt: '2026-10-21T00:00:00.000Z',
      backend: 'remote-docker',
    } satisfies BoxRegistration;

    const box = mapRegistrationToBox(registration);

    expect(box.agent).toBe('shell');
    expect(box.lastAgent).toBeUndefined();
  });
});
