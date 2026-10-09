// POST /api/v1/workspaces/:id/tasks/assign — point several tasks at one box (or
// at the create job that will become one). This is the bulk form the manager
// uses when it groups tasks into a box; `todo` tasks become `in_progress`.
import { backendOrNull } from '../../../../lib/backend';
import { timelineMeta } from '../../../../lib/actor';
import { fail, failFromAction, ok } from '../../../../lib/envelope';
import { journaledApiMutation } from '../../../../lib/idempotency';
import { parseTaskAssign, readJson } from '../../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return fail('invalid_request', parsedBody.message);
  const parsed = parseTaskAssign(parsedBody.value, { requireIds: true });
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const { ids, boxId, boxJobId, note } = parsed.value;
  const target = boxId ? { boxId } : { boxJobId: boxJobId! };
  const meta = await timelineMeta(req, backend, { wsId: id, note });
  const mutation = await journaledApiMutation({
    req,
    kind: 'task.assign',
    request: { workspaceId: id, ids, target },
    reconcile: async () => {
      const tasks = await backend.listTasks(id);
      if (!tasks) return { state: 'unreconcilable', reason: `workspace ${id} disappeared` };
      const selected = tasks.filter((task) => ids!.includes(task.id));
      if (selected.length !== ids!.length) {
        return { state: 'unreconcilable', reason: 'one or more assigned tasks disappeared' };
      }
      const matches = selected.every((task) =>
        'boxId' in target ? task.boxId === target.boxId : task.boxJobId === target.boxJobId,
      );
      return matches
        ? { state: 'completed', result: { ok: true as const, tasks: selected } }
        : { state: 'unreconcilable', reason: 'task assignment changed after the pending write' };
    },
    effect: () => backend.assignTasks(id, ids!, target, meta),
  });
  if (!mutation.ok) return mutation.response;
  const res = mutation.value;
  if (!res.ok) return failFromAction(res.error);
  return ok({ tasks: res.tasks, replayed: mutation.replayed });
}
