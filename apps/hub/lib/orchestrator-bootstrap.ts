import { lookup } from 'node:dns/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncTransport } from '@agentbox/core';

export const ORCHESTRATOR_BOOTSTRAP_PATH = '/workspace/.agentbox-orchestrator-bootstrap.json';

const CAPABILITY = /^[A-Za-z0-9._~-]{32,512}$/;
const PROTOCOL = {
  context: 'POST /v1/worker/context',
  events: 'POST /v1/worker/events/{action}',
  settle: 'POST /v1/worker/settle',
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Validate and canonicalize the one closed worker-bootstrap document accepted by the Hub. */
export function canonicalOrchestratorBootstrap(value: string, now = Date.now()): string {
  if (Buffer.byteLength(value) > 4_096 || value.includes('\u0000')) {
    throw new Error('orchestrator bootstrap is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('orchestrator bootstrap is invalid');
  }
  const row = record(parsed);
  const protocol = record(row?.protocol);
  let controller: URL;
  try {
    controller = new URL(String(row?.controller ?? ''));
  } catch {
    throw new Error('orchestrator bootstrap is invalid');
  }
  const expiresAt = String(row?.expiresAt ?? '');
  const expiry = Date.parse(expiresAt);
  if (
    !row ||
    Object.keys(row).sort().join(',') !== 'capability,controller,expiresAt,protocol,version' ||
    row.version !== 1 ||
    controller.protocol !== 'https:' ||
    controller.username !== '' ||
    controller.password !== '' ||
    controller.search !== '' ||
    controller.hash !== '' ||
    controller.toString().length > 2_048 ||
    !CAPABILITY.test(String(row.capability ?? '')) ||
    !Number.isFinite(expiry) ||
    expiry <= now ||
    expiry > now + 30 * 24 * 60 * 60 * 1_000 ||
    !protocol ||
    Object.keys(protocol).sort().join(',') !== 'context,events,settle' ||
    protocol.context !== PROTOCOL.context ||
    protocol.events !== PROTOCOL.events ||
    protocol.settle !== PROTOCOL.settle
  ) {
    throw new Error('orchestrator bootstrap is invalid');
  }
  return JSON.stringify({
    version: 1,
    controller: controller.toString().replace(/\/$/, ''),
    capability: row.capability,
    expiresAt,
    protocol: PROTOCOL,
  });
}

/** Stage capability material through the file transport, never through process arguments or logs. */
export async function stageOrchestratorBootstrap(
  transport: SyncTransport,
  canonical: string,
  resolveIpv4: (hostname: string) => Promise<{ address: string }> = (hostname) =>
    lookup(hostname, { family: 4 }),
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agentbox-orchestrator-bootstrap-'));
  const source = join(dir, 'bootstrap.json');
  try {
    await writeFile(source, canonical, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await transport.pushFile(source, ORCHESTRATOR_BOOTSTRAP_PATH, {
      uid: 1000,
      mode: 0o600,
    });
    if ((await transport.readText(ORCHESTRATOR_BOOTSTRAP_PATH)) !== canonical) {
      throw new Error('orchestrator bootstrap staging verification failed');
    }
    await ensureTailnetControllerResolution(transport, canonical, resolveIpv4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function ensureTailnetControllerResolution(
  transport: SyncTransport,
  canonical: string,
  resolveIpv4: (hostname: string) => Promise<{ address: string }>,
): Promise<void> {
  const hostname = new URL(String(record(JSON.parse(canonical))?.controller)).hostname;
  if (!hostname.endsWith('.ts.net')) return;
  const { address } = await resolveIpv4(hostname);
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255) ||
    octets[0] !== 100 ||
    octets[1]! < 64 ||
    octets[1]! > 127
  ) {
    throw new Error('orchestrator controller did not resolve to a tailnet address');
  }
  const result = await transport.exec(
    [
      '/bin/sh',
      '-c',
      'grep -F " $1" /etc/hosts >/dev/null 2>&1 || printf "%s %s\\n" "$2" "$1" >> /etc/hosts',
      'agentbox-orchestrator-host',
      hostname,
      address,
    ],
    { user: 'root', noRetry: true },
  );
  if (result.exitCode !== 0) {
    throw new Error('orchestrator controller host staging failed');
  }
  const verified = await transport.exec(['getent', 'hosts', hostname], { noRetry: true });
  if (verified.exitCode !== 0 || !verified.stdout.split(/\s+/).includes(address)) {
    throw new Error('orchestrator controller host staging verification failed');
  }
}
