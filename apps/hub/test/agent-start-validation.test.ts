import { describe, expect, it } from 'vitest';
import { parseStartBoxAgent } from '../app/(dashboard)/api/v1/lib/validate';

describe('existing-box agent start request', () => {
  it('preserves credential-free/current-default omissions', () => {
    expect(parseStartBoxAgent({ agent: 'pi', prompt: 'ship it' })).toEqual({
      ok: true,
      value: { agent: 'pi', prompt: 'ship it' },
    });
  });

  it('accepts bounded naming hooks, launch args, and an exact expected version', () => {
    expect(
      parseStartBoxAgent({
        agent: 'pi',
        args: ['--model', 'openai-codex/gpt-5'],
        sessionName: 'pi-task-7',
        sessionLabel: 'Personal Task 7',
        expectedVersion: '0.85.1',
      }),
    ).toEqual({
      ok: true,
      value: {
        agent: 'pi',
        args: ['--model', 'openai-codex/gpt-5'],
        sessionName: 'pi-task-7',
        sessionLabel: 'Personal Task 7',
        expectedVersion: '0.85.1',
      },
    });
  });

  it('rejects oversized or unsafe detached startup inputs', () => {
    expect(parseStartBoxAgent({ agent: 'pi', prompt: 'x'.repeat(16_385) })).toMatchObject({
      ok: false,
    });
    expect(parseStartBoxAgent({ agent: 'pi', prompt: 'unsafe\u0000prompt' })).toMatchObject({
      ok: false,
    });
    expect(
      parseStartBoxAgent({ agent: 'pi', orchestratorBootstrap: 'x'.repeat(4_097) }),
    ).toMatchObject({ ok: false });
  });

  it('rejects missing or malformed orchestrator version pins when supplied', () => {
    expect(parseStartBoxAgent({ agent: 'pi', expectedVersion: '' })).toMatchObject({ ok: false });
    expect(parseStartBoxAgent({ agent: 'pi', expectedVersion: 'latest' })).toMatchObject({
      ok: false,
    });
  });

  it('does not carry legacy singular profile fields', () => {
    const parsed = parseStartBoxAgent({ agent: 'pi', credentialProfile: 'personal' });
    // Unknown fields are deliberately ignored by this narrow U4 request parser,
    // so they cannot influence staging; the resulting value proves none crossed.
    expect(parsed).toEqual({ ok: true, value: { agent: 'pi' } });
  });

  it('rejects malformed tmux names before provider work', () => {
    expect(parseStartBoxAgent({ agent: 'pi', sessionName: 'bad name' })).toMatchObject({
      ok: false,
    });
  });
});
