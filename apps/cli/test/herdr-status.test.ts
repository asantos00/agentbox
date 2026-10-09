import { describe, expect, it, vi } from 'vitest';
import {
  ensureHerdrAgentName,
  herdrAgentNamingState,
  herdrStatusActive,
  mapActivityToAgentState,
  normalizeHerdrAgentName,
} from '../src/terminal/herdr-status.js';

describe('mapActivityToAgentState', () => {
  it('maps working/compacting to a working state', () => {
    expect(mapActivityToAgentState('claude', 'working')).toEqual({
      state: 'working',
      message: 'claude · working',
    });
    expect(mapActivityToAgentState('codex', 'compacting')).toEqual({
      state: 'working',
      message: 'codex · working',
    });
  });

  it('maps question/waiting/end-plan/error to blocked (Herdr handles needs-input)', () => {
    expect(mapActivityToAgentState('claude', 'question')).toEqual({
      state: 'blocked',
      message: 'claude · needs input',
    });
    expect(mapActivityToAgentState('claude', 'waiting')?.state).toBe('blocked');
    expect(mapActivityToAgentState('claude', 'end-plan')).toEqual({
      state: 'blocked',
      message: 'claude · plan ready',
    });
    expect(mapActivityToAgentState('claude', 'error')).toEqual({
      state: 'blocked',
      message: 'claude · error',
    });
  });

  it('maps idle to an idle state', () => {
    expect(mapActivityToAgentState('claude', 'idle')).toEqual({
      state: 'idle',
      message: 'claude · idle',
    });
  });

  it('uses the agent name as the label per mode', () => {
    expect(mapActivityToAgentState('opencode', 'working')?.message).toBe('opencode · working');
  });

  it('returns null (leave as-is) for unknown/absent state and for shell', () => {
    expect(mapActivityToAgentState('claude', 'unknown')).toBeNull();
    expect(mapActivityToAgentState('claude', undefined)).toBeNull();
    expect(mapActivityToAgentState('shell', 'working')).toBeNull();
  });
});

describe('acknowledged Herdr naming', () => {
  const env = {
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: '/tmp/herdr-naming.sock',
    HERDR_PANE_ID: 'w1:p9',
  };

  it('normalizes labels to Herdr grammar and length', () => {
    expect(normalizeHerdrAgentName('  Personal API / Worker #1  ')).toBe('personal-api-worker-1');
    expect(normalizeHerdrAgentName('99 Problems')).toBe('problems');
    expect(normalizeHerdrAgentName('---')).toBe('agentbox');
    expect(normalizeHerdrAgentName(`A${'x'.repeat(80)}`)).toHaveLength(32);
  });

  it('renames a stale agent and confirms through agent.list', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ agents: [{ pane_id: 'w1:p9', name: 'stale' }] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ agents: [{ pane_id: 'w1:p9', name: 'personal-worker' }] });
    await expect(ensureHerdrAgentName('Personal Worker', env, request)).resolves.toBe('confirmed');
    expect(request).toHaveBeenNthCalledWith(
      2,
      'agent.rename',
      { target: 'w1:p9', name: 'personal-worker' },
      env,
    );
  });

  it('stays degraded after rename failure and retries after reconnect/report', async () => {
    const failed = vi.fn().mockResolvedValueOnce({ agents: [] }).mockResolvedValueOnce(null);
    await expect(ensureHerdrAgentName('Reconnect Worker', env, failed)).resolves.toBe('degraded');
    expect(herdrAgentNamingState('Reconnect Worker', env)).toBe('degraded');

    const retried = vi
      .fn()
      .mockResolvedValueOnce({ agents: [] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ agents: [{ pane_id: 'w1:p9', name: 'reconnect-worker' }] });
    await expect(ensureHerdrAgentName('Reconnect Worker', env, retried)).resolves.toBe('confirmed');
  });
});

describe('herdrStatusActive', () => {
  const live = {
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: '/tmp/herdr.sock',
    HERDR_PANE_ID: 'w1:p1',
  };

  it('is true only with HERDR_ENV=1 and a non-empty socket path and pane id', () => {
    expect(herdrStatusActive(live)).toBe(true);
    expect(herdrStatusActive({ ...live, HERDR_SOCKET_PATH: '' })).toBe(false);
    expect(herdrStatusActive({ ...live, HERDR_PANE_ID: '' })).toBe(false);
    expect(herdrStatusActive({ ...live, HERDR_ENV: '0' })).toBe(false);
    expect(herdrStatusActive({})).toBe(false);
  });

  it('does not depend on TMUX (works even when tmux is nested in Herdr)', () => {
    expect(herdrStatusActive({ ...live, TMUX: '/tmp/tmux-0/default,1,0' })).toBe(true);
  });
});
