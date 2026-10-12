import { createHash } from 'node:crypto';
import { open, mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIR, withFileLock } from '@agentbox/config';

export type OperationKind =
  | 'task.create'
  | 'box.create'
  | 'agent.launch'
  | 'task.assign'
  | 'box.lifecycle';

export type OperationStatus = 'pending' | 'completed' | 'blocked';

export interface OperationJournalEntry<T = unknown> {
  version: 1;
  key: string;
  kind: OperationKind;
  requestHash: string;
  tag: string;
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
  result?: T;
  reason?: string;
}

export class OperationConflictError extends Error {
  constructor(readonly entry: OperationJournalEntry) {
    super(`idempotency key '${entry.key}' was already used for a different request`);
    this.name = 'OperationConflictError';
  }
}

export class OperationBlockedError extends Error {
  constructor(readonly entry: OperationJournalEntry) {
    super(entry.reason ?? `operation '${entry.key}' is blocked pending reconciliation`);
    this.name = 'OperationBlockedError';
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function operationRequestHash(kind: OperationKind, request: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ kind, request })))
    .digest('hex');
}

export function operationTag(key: string): string {
  return `agentbox-op-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

async function durableJson(path: string, value: unknown): Promise<void> {
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  const tmp = `${path}.tmp.${String(process.pid)}.${Date.now().toString(36)}`;
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  const dir = await open(path.slice(0, path.lastIndexOf('/')), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

export const DEFAULT_OPERATION_JOURNAL_DIR = join(STATE_DIR, 'operations');

export class FsOperationJournal {
  constructor(private readonly root = DEFAULT_OPERATION_JOURNAL_DIR) {}

  private pathFor(key: string): string {
    return join(this.root, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  async read<T = unknown>(key: string): Promise<OperationJournalEntry<T> | null> {
    try {
      return JSON.parse(await readFile(this.pathFor(key), 'utf8')) as OperationJournalEntry<T>;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw error;
    }
  }

  async begin<T = unknown>(input: {
    key: string;
    kind: OperationKind;
    request: unknown;
    tag?: string;
  }): Promise<{ entry: OperationJournalEntry<T>; created: boolean }> {
    const path = this.pathFor(input.key);
    return withFileLock(path, async () => {
      const existing = await this.read<T>(input.key);
      const requestHash = operationRequestHash(input.kind, input.request);
      if (existing) {
        if (existing.kind !== input.kind || existing.requestHash !== requestHash) {
          throw new OperationConflictError(existing);
        }
        return { entry: existing, created: false };
      }
      const now = new Date().toISOString();
      const entry: OperationJournalEntry<T> = {
        version: 1,
        key: input.key,
        kind: input.kind,
        requestHash,
        tag: input.tag ?? operationTag(input.key),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      await durableJson(path, entry);
      return { entry, created: true };
    });
  }

  async complete<T>(key: string, result: T): Promise<OperationJournalEntry<T>> {
    return this.finish(key, { status: 'completed', result });
  }

  async block(key: string, reason: string): Promise<OperationJournalEntry> {
    return this.finish(key, { status: 'blocked', reason });
  }

  private async finish<T>(
    key: string,
    patch: { status: 'completed'; result: T } | { status: 'blocked'; reason: string },
  ): Promise<OperationJournalEntry<T>> {
    const path = this.pathFor(key);
    return withFileLock(path, async () => {
      const current = await this.read<T>(key);
      if (!current) throw new Error(`operation '${key}' has no pending journal record`);
      if (current.status === 'completed') return current;
      const next = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      } as OperationJournalEntry<T>;
      await durableJson(path, next);
      return next;
    });
  }
}

export type ReconcileResult<T> =
  | { state: 'completed'; result: T }
  | { state: 'absent' }
  | { state: 'unreconcilable'; reason: string };

export async function runJournaledOperation<T>(input: {
  journal: FsOperationJournal;
  key: string;
  kind: OperationKind;
  request: unknown;
  tag?: string;
  reconcile: (entry: OperationJournalEntry<T>) => Promise<ReconcileResult<T>>;
  effect: (entry: OperationJournalEntry<T>) => Promise<T>;
  crashAt?: 'before-external' | 'after-external';
}): Promise<{ result: T; replayed: boolean; tag: string }> {
  const begun = await input.journal.begin<T>(input);
  const entry = begun.entry;
  if (entry.status === 'completed') {
    return { result: entry.result as T, replayed: true, tag: entry.tag };
  }
  if (entry.status === 'blocked') throw new OperationBlockedError(entry);

  if (!begun.created) {
    const reconciled = await input.reconcile(entry);
    if (reconciled.state === 'completed') {
      await input.journal.complete(input.key, reconciled.result);
      return { result: reconciled.result, replayed: true, tag: entry.tag };
    }
    if (reconciled.state === 'unreconcilable') {
      const blocked = await input.journal.block(input.key, reconciled.reason);
      throw new OperationBlockedError(blocked);
    }
  }

  if (input.crashAt === 'before-external') throw new Error('injected crash before external commit');
  const result = await input.effect(entry);
  if (input.crashAt === 'after-external') throw new Error('injected crash after external commit');
  await input.journal.complete(input.key, result);
  return { result, replayed: false, tag: entry.tag };
}
