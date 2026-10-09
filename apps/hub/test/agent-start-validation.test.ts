import { describe, expect, it } from 'vitest';
import { parseStartBoxAgent } from '../app/(dashboard)/api/v1/lib/validate';

describe('existing-box agent start request', () => {
  it('preserves credential-free/current-default omissions', () => {
    expect(parseStartBoxAgent({ agent: 'pi', prompt: 'ship it' })).toEqual({
      ok: true,
      value: { agent: 'pi', prompt: 'ship it' },
    });
  });

  it('accepts bounded naming hooks and launch args', () => {
    expect(
      parseStartBoxAgent({
        agent: 'pi',
        args: ['--model', 'openai-codex/gpt-5'],
        sessionName: 'pi-task-7',
        sessionLabel: 'Personal Task 7',
      }),
    ).toMatchObject({ ok: true });
  });

  it('does not carry profile fields owned by later units', () => {
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
