import {
  FsOperationJournal,
  OperationBlockedError,
  OperationConflictError,
  runJournaledOperation,
  type OperationKind,
  type ReconcileResult,
} from '@agentbox/relay/operation-journal';
import { fail } from './envelope';

const journal = new FsOperationJournal();
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export type JournaledApiResult<T> =
  | { ok: true; value: T; replayed: boolean; operationTag?: string }
  | { ok: false; response: Response };

export async function journaledApiMutation<T>(input: {
  req: Request;
  kind: OperationKind;
  request: unknown;
  effect: (tag: string) => Promise<T>;
  reconcile: (tag: string) => Promise<ReconcileResult<T>>;
}): Promise<JournaledApiResult<T>> {
  const key = input.req.headers.get('idempotency-key');
  if (!key) return { ok: true, value: await input.effect(''), replayed: false };
  if (!KEY_RE.test(key)) {
    return {
      ok: false,
      response: fail('invalid_request', 'Idempotency-Key must be 1-200 URL-safe characters'),
    };
  }
  try {
    const out = await runJournaledOperation<T>({
      journal,
      key,
      kind: input.kind,
      request: input.request,
      reconcile: (entry) => input.reconcile(entry.tag),
      effect: (entry) => input.effect(entry.tag),
      ...(process.env['AGENTBOX_OPERATION_CRASH_AT'] === 'before-external' ||
      process.env['AGENTBOX_OPERATION_CRASH_AT'] === 'after-external'
        ? { crashAt: process.env['AGENTBOX_OPERATION_CRASH_AT'] }
        : {}),
    });
    return { ok: true, value: out.result, replayed: out.replayed, operationTag: out.tag };
  } catch (error) {
    if (error instanceof OperationConflictError) {
      return { ok: false, response: fail('conflict', error.message, { operation: error.entry }) };
    }
    if (error instanceof OperationBlockedError) {
      return {
        ok: false,
        response: fail('conflict', error.message, {
          operation: error.entry,
          recovery: 'operator reconciliation required; the hub will not retry this effect',
        }),
      };
    }
    throw error;
  }
}
