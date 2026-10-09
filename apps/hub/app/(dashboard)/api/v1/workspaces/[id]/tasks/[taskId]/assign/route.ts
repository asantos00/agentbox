// POST /api/v1/workspaces/:id/tasks/:taskId/assign — point one task at a box
// (`{ boxId }`) or at the create job that will become one (`{ boxJobId }`).
import { backendOrNull } from '../../../../../lib/backend';
import { timelineMeta } from '../../../../../lib/actor';
import { fail, failFromAction, ok } from '../../../../../lib/envelope';
import { journaledApiMutation } from '../../../../../lib/idempotency';
import { parseTaskAssign, readJson } from '../../../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; taskId: string }> },
): Promise<Response> {
  const { id, taskId } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const parsed = parseTaskAssign(parsedBody.value);
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const { boxId, boxJobId, note } = parsed.value;
  const target = boxId ? { boxId } : { boxJobId: boxJobId! };
  const meta = await timelineMeta(req, backend, { wsId: id, note });
  const mutation = await journaledApiMutation({
    req,
    kind: 'task.assign',
    request: { workspaceId: id, taskId, target },
    reconcile: async () => {
      const task = (await backend.listTasks(id))?.find((candidate) => candidate.id === taskId);
      if (!task) return { state: 'unreconcilable', reason: `task ${taskId} disappeared` };
      const matches =
        'boxId' in target ? task.boxId === target.boxId : task.boxJobId === target.boxJobId;
      return matches
        ? { state: 'completed', result: { ok: true as const, tasks: [task] } }
        : { state: 'unreconcilable', reason: 'task assignment changed after the pending write' };
    },
    effect: () => backend.assignTasks(id, [taskId], target, meta),
  });
  if (!mutation.ok) return mutation.response;
  const res = mutation.value;
  if (!res) return fail('internal', 'assignment operation returned no result');
  if (!res.ok) return failFromAction(res.error);
  const task = res.tasks[0];
  if (!task) return fail('internal', 'assignment returned no task');
  return ok({ ...task, replayed: mutation.replayed });
}
