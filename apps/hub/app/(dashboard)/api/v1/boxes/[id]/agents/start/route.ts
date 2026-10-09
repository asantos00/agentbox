// POST /api/v1/boxes/:id/agents/start — install/repair and launch one TUI
// agent in an existing box. This is the versioned unattended dispatch seam;
// named credential profiles and attempt packages are staged by later units.
import { backendOrNull } from '../../../../lib/backend';
import { fail, failFromAction, ok } from '../../../../lib/envelope';
import { journaledApiMutation } from '../../../../lib/idempotency';
import { parseStartBoxAgent, readJson } from '../../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  const sys = globalThis.__AGENTBOX_HUB_SYSTEM;
  const allowedAgents = sys ? sys.agents().map((agent) => agent.id) : undefined;
  const parsed = parseStartBoxAgent(body.value, allowedAgents);
  if (!parsed.ok) return fail('invalid_request', parsed.message);

  const mutation = await journaledApiMutation({
    req,
    kind: 'agent.launch',
    request: { boxId: id, ...parsed.value },
    // The detached start is itself reconciliatory: it probes the deterministic
    // tmux session after a transport error and accepts an already-live session.
    reconcile: () => Promise.resolve({ state: 'absent' }),
    effect: () => backend.startAgent(id, parsed.value),
  });
  if (!mutation.ok) return mutation.response;
  if (!mutation.value.ok) return failFromAction(mutation.value.error);
  return ok({
    ...mutation.value,
    replayed: mutation.replayed,
    ...(mutation.operationTag ? { operationTag: mutation.operationTag } : {}),
  });
}
