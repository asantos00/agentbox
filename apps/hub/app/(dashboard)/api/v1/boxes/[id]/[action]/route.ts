// POST /api/v1/boxes/:id/:action — lifecycle: start | pause | resume | stop |
// destroy | screen.
// Mutations need the in-process host backend; the Postgres/plane path 503s (hosted
// writes are a documented follow-up).
import { backendOrNull } from '../../../lib/backend';
import { timelineMeta } from '../../../lib/actor';
import { fail, failFromAction, ok } from '../../../lib/envelope';
import { journaledApiMutation } from '../../../lib/idempotency';
import { isLifecycleAction, LIFECYCLE_ACTIONS, readJson } from '../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; action: string }> },
): Promise<Response> {
  const { id, action } = await ctx.params;
  if (!isLifecycleAction(action)) {
    return fail('invalid_request', `unknown action: ${action}`, {
      allowed: [...LIFECYCLE_ACTIONS],
    });
  }
  // In-flight create jobs surface in GET /boxes as synthetic `creating`/`error`
  // boxes with a `job:` id — they have no real container yet, so lifecycle would
  // 404 in the backend and contradict the GET. Reject with a clear 409 instead.
  // `destroy` is the exception: it dismisses a failed create (clears the queue
  // manifest), so let it fall through to the backend which handles `job:` ids.
  if (id.startsWith('job:') && action !== 'destroy') {
    return fail('conflict', `box ${id} is still being created; ${action} is not available yet`, {
      jobId: id.slice('job:'.length),
    });
  }
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const meta = await timelineMeta(req, backend);

  // `destroy` carries an optional `keepSnapshot` (mirrors the CLI's flag — a
  // docker box's snapshot dir is kept when true); every other action is body-less.
  if (action === 'destroy') {
    const parsed = await readJson(req);
    if (!parsed.ok) return fail('invalid_request', parsed.message);
    const keepSnapshot =
      typeof parsed.value === 'object' &&
      parsed.value !== null &&
      (parsed.value as { keepSnapshot?: unknown }).keepSnapshot === true;
    const mutation = await journaledApiMutation({
      req,
      kind: 'box.lifecycle',
      request: { boxId: id, action, keepSnapshot },
      reconcile: async () => {
        const exists = (await backend.getData()).boxes.some((box) => box.id === id);
        return exists ? { state: 'absent' } : { state: 'completed', result: { ok: true as const } };
      },
      effect: () => backend.destroy(id, { keepSnapshot }, meta),
    });
    if (!mutation.ok) return mutation.response;
    if (!mutation.value) return fail('internal', 'lifecycle operation returned no result');
    if (!mutation.value.ok) return failFromAction(mutation.value.error);
    return ok({ ok: true, replayed: mutation.replayed });
  }

  const mutation = await journaledApiMutation({
    req,
    kind: 'box.lifecycle',
    request: { boxId: id, action },
    reconcile: async () => {
      if (action === 'screen') {
        return {
          state: 'unreconcilable',
          reason: 'screen has no provider-visible committed state',
        };
      }
      const box = (await backend.getData()).boxes.find((candidate) => candidate.id === id);
      if (!box)
        return { state: 'unreconcilable', reason: `box ${id} disappeared during ${action}` };
      const target = action === 'pause' ? 'paused' : action === 'stop' ? 'stopped' : 'running';
      return box.state === target
        ? { state: 'completed', result: { ok: true as const } }
        : { state: 'absent' };
    },
    effect: () => backend[action](id, meta),
  });
  if (!mutation.ok) return mutation.response;
  if (!mutation.value) return fail('internal', 'lifecycle operation returned no result');
  if (!mutation.value.ok) return failFromAction(mutation.value.error);
  return ok({ ok: true, replayed: mutation.replayed });
}
