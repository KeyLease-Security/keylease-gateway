import {
  fileSessionStore,
  type LeaseSession,
  type SessionStore,
} from './lease.js';
import type { CliIo } from '../index.js';

export interface SessionsArgs {
  prune: boolean;
  json: boolean;
}

export interface SessionsDeps {
  store?: SessionStore;
  now?: () => number;
}

interface SessionRow {
  service: string;
  lease_id: string;
  expires_at: number;
  status: 'active' | 'expired';
}

function sessionRows(sessions: Record<string, LeaseSession[]>, now: number): SessionRow[] {
  return Object.values(sessions)
    .flat()
    .map((session): SessionRow => {
      const status: SessionRow['status'] = session.expiresAt > now ? 'active' : 'expired';
      return {
        service: session.service,
        lease_id: session.leaseId,
        expires_at: session.expiresAt,
        status,
      };
    })
    .sort((left, right) => left.service.localeCompare(right.service) || left.lease_id.localeCompare(right.lease_id));
}

function formatExpiry(expiresAt: number): string {
  const date = new Date(expiresAt * 1000);
  return Number.isNaN(date.getTime()) ? String(expiresAt) : date.toISOString();
}

function renderSessionTable(rows: SessionRow[], io: CliIo): void {
  const headers = ['SERVICE', 'LEASE ID', 'EXPIRES AT', 'STATUS'];
  const values = rows.map((row) => [
    row.service,
    row.lease_id,
    formatExpiry(row.expires_at),
    row.status,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((row) => row[index]?.length ?? 0)),
  );
  const render = (cells: string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();

  io.out(render(headers));
  for (const row of values) io.out(render(row));
  if (rows.length === 0) io.out('(no stored sessions)');
}

/** `keylease sessions [--prune] [--json]` */
export async function sessionsCommand(
  args: SessionsArgs,
  io: CliIo,
  deps: SessionsDeps = {},
): Promise<number> {
  const store = deps.store ?? fileSessionStore();
  const sessions = await store.load();
  const now = Math.floor((deps.now ?? Date.now)() / 1000);

  if (args.prune) {
    let removed = 0;
    const remaining: Record<string, LeaseSession[]> = {};
    for (const [service, list] of Object.entries(sessions)) {
      const unexpired = list.filter((s) => s.expiresAt > now);
      removed += list.length - unexpired.length;
      if (unexpired.length > 0) {
        remaining[service] = unexpired;
      }
    }
    if (removed > 0) await store.saveAll(remaining);

    if (args.json) {
      io.out(JSON.stringify({ removed }, null, 2));
    } else {
      io.out(`Pruned ${removed} expired session${removed === 1 ? '' : 's'}.`);
    }
    return 0;
  }

  const rows = sessionRows(sessions, now);
  if (args.json) {
    io.out(JSON.stringify(rows, null, 2));
  } else {
    renderSessionTable(rows, io);
  }
  return 0;
}
