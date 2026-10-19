import { FsOperationJournal } from '@agentbox/relay/operation-journal';
import { fail, ok } from '../../lib/envelope';
import { observeJournaledApiMutation } from '../../lib/idempotency';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const journal = new FsOperationJournal();

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

export function normalizedResult(
  kind: 'box.create' | 'agent.launch',
  value: unknown,
): Record<string, unknown> | null {
  const row = record(value);
  if (!row) return null;
  if (row.ok === false) return { ok: false, errorCode: 'action_failed' };
  if (row.ok !== true) return null;
  if (kind === 'box.create') {
    return boundedId(row.jobId) ? { jobId: row.jobId } : null;
  }
  if (
    !boundedId(row.agent) ||
    !boundedId(row.sessionName) ||
    typeof row.sessionLabel !== 'string' ||
    row.sessionLabel.length < 1 ||
    row.sessionLabel.length > 120 ||
    typeof row.installed !== 'boolean' ||
    (row.version !== undefined &&
      (typeof row.version !== 'string' ||
        !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(row.version)))
  ) {
    return null;
  }
  return {
    agent: row.agent,
    sessionName: row.sessionName,
    sessionLabel: row.sessionLabel,
    installed: row.installed,
    ...(row.version === undefined ? {} : { version: row.version }),
  };
}

/** Read-only status for orchestrator-owned idempotency keys; never resumes an effect. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await ctx.params;
  let observation;
  try {
    observation = await observeJournaledApiMutation(journal, key);
  } catch {
    return fail('invalid_request', 'invalid operation key');
  }
  if (observation.state === 'absent') return ok(observation);
  if (observation.kind !== 'box.create' && observation.kind !== 'agent.launch') {
    return fail('not_found', 'operation is not available on this control surface');
  }
  if (observation.state === 'ambiguous') return ok(observation);
  const result = normalizedResult(observation.kind, observation.result);
  if (!result) return fail('internal', 'operation result is not safe to expose');
  return ok({ ...observation, result });
}
