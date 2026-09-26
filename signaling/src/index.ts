import { DurableObject } from 'cloudflare:workers';
import { isRoomId, relayPingText, relayPongText } from '../../src/shared/net/relayProtocol';
import type { RoomSocket, SocketInfo } from './RoomCore';
import { RoomCore } from './RoomCore';
import { isAllowedOrigin } from './origin';

/**
 * PIX LIGHTS OUT の中継 (シグナリング)。部屋 (ロビー) ごとに 1 つの Durable Object (RoomObject) が、
 * ホストと参加者の WebSocket の間で暗号化済みの接続情報を受け渡す。プロトコルは src/shared/net/relayProtocol.ts。
 *
 *   GET /rooms/<部屋 ID>  (Upgrade: websocket、Origin は ALLOWED_ORIGINS のどれか)
 *
 * WebSocket Hibernation API を使うので、待っている間 (誰も送っていない間) は Durable Object がメモリから外れ、
 * 時間 (GB-s) の課金が止まる。中継した中身・IP アドレスはどこにも保存・記録しない (console.log もしない)。
 */

export interface Env {
  ROOMS: DurableObjectNamespace<RoomObject>;
  /** 許可する Origin (カンマ区切り。`http://localhost:*` のようにポートを * にできる) */
  ALLOWED_ORIGINS: string;
  /** 部屋の寿命 (秒)。省略時 30 分。30 分より長くはできない (wrangler dev での期限切れの確認用に短くする) */
  ROOM_LIFETIME_SEC?: string;
}

const roomPathPattern = /^\/rooms\/([A-Za-z0-9_-]{22})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = roomPathPattern.exec(url.pathname);
    if (!m || !isRoomId(m[1])) return new Response('not found', { status: 404 });
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('websocket only', { status: 426 });
    }
    // ブラウザは必ず Origin を付ける。ほかのサイトのページから使われないように、許可したものだけ通す
    if (!isAllowedOrigin(request.headers.get('Origin'), env.ALLOWED_ORIGINS)) return new Response('forbidden', { status: 403 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/** WebSocket を RoomCore の形に包む (添付情報を状態として使う) */
function wrap(ws: WebSocket): RoomSocket {
  return {
    get info() {
      return ws.deserializeAttachment() as SocketInfo;
    },
    save(info) {
      ws.serializeAttachment(info);
    },
    send(text) {
      ws.send(text);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
  };
}

export class RoomObject extends DurableObject<Env> {
  private readonly core: RoomCore;
  /** 置いてあるアラームの時刻 (メモリから外れたら undefined に戻り、ストレージから読み直す) */
  private alarmAt: number | null | undefined = undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new RoomCore({
      sockets: () => this.ctx.getWebSockets().map(wrap),
      now: () => Date.now(),
      roomLifetimeMs: env.ROOM_LIFETIME_SEC ? Number(env.ROOM_LIFETIME_SEC) * 1000 : undefined,
    });
    // 生存確認は Durable Object を起こさずに返す
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(relayPingText, relayPongText));
  }

  async fetch(request: Request): Promise<Response> {
    const m = roomPathPattern.exec(new URL(request.url).pathname);
    if (!m) return new Response('not found', { status: 404 });
    if (!this.core.canAccept()) return new Response('busy', { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(RoomCore.initialInfo(m[1], crypto.randomUUID(), Date.now()));
    await this.updateAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.core.onMessage(wrap(ws), message);
    await this.updateAlarm();
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.core.onClose(wrap(ws));
    // 相手からの close に答える (1005・1006 は送れないので 1000 にする)
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye');
    } catch {
      // すでに閉じている
    }
    await this.updateAlarm();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.core.onClose(wrap(ws));
    await this.updateAlarm();
  }

  async alarm(): Promise<void> {
    // 鳴ったアラームは消えている
    this.alarmAt = null;
    this.core.onAlarm();
    await this.updateAlarm();
  }

  /** 名乗る前の接続の締め切り・部屋の寿命に合わせてアラームを置き直す */
  private async updateAlarm(): Promise<void> {
    const at = this.core.nextAlarmAt();
    if (this.alarmAt === undefined) this.alarmAt = await this.ctx.storage.getAlarm();
    if (at === this.alarmAt) return;
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
  }
}
