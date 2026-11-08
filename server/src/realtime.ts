import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Pool } from 'pg';
import { tx } from './db.ts';

const MAX_PER_USER = 5, MAX_BUFFER = 1_000_000, IDLE_MS = 5 * 60_000;

/** Fan-out of committed plan changes. Subscriptions are authorised by a single-use ticket bound to (user, project). */
export class Hub {
  private subs = new Map<string, Set<WebSocket>>();
  private perUser = new Map<string, number>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  private timer: NodeJS.Timeout | undefined;

  broadcast(projectId: string, msg: unknown): void {
    const set = this.subs.get(projectId);
    if (!set) return;
    const text = JSON.stringify(msg);
    for (const ws of set) {
      if (ws.bufferedAmount > MAX_BUFFER) { ws.terminate(); continue; }     // slow consumer: drop, it can resync from the snapshot
      ws.send(text);
    }
  }
  count(projectId: string): number { return this.subs.get(projectId)?.size ?? 0; }

  /** close sockets of a user in a project (role removed) with 4403 */
  revoke(projectId: string, userId: string): void {
    for (const ws of this.subs.get(projectId) ?? []) if ((ws as WebSocket & { uid?: string }).uid === userId) ws.close(4403, 'access revoked');
  }

  attach(server: Server, pool: Pool): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.upgrade(req, socket, head, pool);
    });
    this.timer = setInterval(() => {
      for (const set of this.subs.values()) for (const ws of set) {
        const w = ws as WebSocket & { alive?: boolean; last?: number };
        if (w.alive === false || Date.now() - (w.last ?? 0) > IDLE_MS) { ws.terminate(); continue; }
        w.alive = false; ws.ping();
      }
    }, 30_000);
    this.timer.unref();
  }
  close(): void {
    if (this.timer) clearInterval(this.timer);
    for (const set of this.subs.values()) for (const ws of set) ws.terminate();
    this.wss.close();
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, pool: Pool): Promise<void> {
    const reject = (code: number, text: string) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    try {
      const url = new URL(req.url ?? '', 'http://x');
      if (url.pathname !== '/realtime') return reject(404, 'Not Found');
      const [tid, tid2] = (url.searchParams.get('ticket') ?? '').split('.');
      if (!tid || !tid2) return reject(401, 'Unauthorized');
      const info = await tx(pool, tid, async (c) => {
        const r = (await c.query(
          'UPDATE realtime_ticket SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING project_id, user_id', [tid2])).rows[0];
        if (!r) return null;
        const m = (await c.query('SELECT role FROM project_member WHERE project_id = $1 AND user_id = $2', [r.project_id, r.user_id])).rows[0];
        return m ? { projectId: r.project_id as string, userId: r.user_id as string } : null;
      }).catch(() => null);
      if (!info) return reject(401, 'Unauthorized');
      const n = this.perUser.get(info.userId) ?? 0;
      if (n >= MAX_PER_USER) return reject(429, 'Too Many Requests');
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const w = ws as WebSocket & { uid?: string; alive?: boolean; last?: number };
        w.uid = info.userId; w.alive = true; w.last = Date.now();
        this.perUser.set(info.userId, n + 1);
        (this.subs.get(info.projectId) ?? this.subs.set(info.projectId, new Set()).get(info.projectId)!).add(ws);
        ws.on('error', () => ws.terminate());                               // PF-001: oversize/invalid frame closes this socket only
        ws.on('pong', () => { w.alive = true; });
        ws.on('message', () => { w.last = Date.now(); });                  // clients send nothing meaningful; any frame counts as activity
        ws.on('close', () => {
          this.subs.get(info.projectId)?.delete(ws);
          this.perUser.set(info.userId, Math.max(0, (this.perUser.get(info.userId) ?? 1) - 1));
        });
        ws.send(JSON.stringify({ type: 'hello', projectId: info.projectId }));
      });
    } catch { reject(400, 'Bad Request'); }
  }
}
