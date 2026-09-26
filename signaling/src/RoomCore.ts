import type { RelayServerFrame } from '../../src/shared/net/relayProtocol';
import {
  isFrameTooLarge,
  parseRelayClientFrame,
  relayCloseCodes,
  relayLimits,
  relayPingText,
  relayPongText,
  roomIdOfSecret,
} from '../../src/shared/net/relayProtocol';

/**
 * 1 つの部屋 (ロビー) の中継の処理。Cloudflare の型に依存しない純粋なクラスで、Durable Object (RoomObject) が
 * WebSocket をこの形に包んで渡す。node の確認 (scripts/sim-net.mjs) からも同じものを動かす。
 *
 * 状態はすべて各 WebSocket の「添付情報」(SocketInfo) に持つ (Hibernation で Durable Object がメモリから消えても、
 * 添付情報は WebSocket と一緒に残る)。部屋の寿命・次の参加者番号はホストの添付情報に置く。
 * ストレージには何も書かない。中継した中身は保存・記録しない。
 */

export type SocketRole = 'pending' | 'host' | 'guest' | 'closed';

export interface SocketInfo {
  /** 接続ごとの ID (同じ接続かを見分ける) */
  id: string;
  roomId: string;
  role: SocketRole;
  /** 参加者の番号 (ホストは 0、名乗る前は -1) */
  peer: number;
  openedAt: number;
  /** ホストだけ: 部屋を作った時刻 (寿命の起点。ホストが入り直しても引き継ぐ) と次の参加者番号 */
  roomCreatedAt: number;
  nextPeer: number;
  /** 送信回数 (合計と、短い間の回数) */
  frames: number;
  burstStart: number;
  burstCount: number;
}

export interface RoomSocket {
  readonly info: SocketInfo;
  /** 添付情報を書き換える */
  save(info: SocketInfo): void;
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface RoomEnv {
  /** 開いている WebSocket すべて */
  sockets(): RoomSocket[];
  /** Date.now() の ms */
  now(): number;
  /** 部屋の寿命 (ms)。既定 relayLimits.roomLifetimeMs (30 分)。それより長くはできない (確認用に短くする) */
  roomLifetimeMs?: number;
}

export class RoomCore {
  private readonly lifetimeMs: number;

  constructor(private readonly env: RoomEnv) {
    const ms = env.roomLifetimeMs;
    this.lifetimeMs = ms !== undefined && Number.isFinite(ms) && ms > 0 ? Math.min(ms, relayLimits.roomLifetimeMs) : relayLimits.roomLifetimeMs;
  }

  /** 新しい接続の添付情報 */
  static initialInfo(roomId: string, id: string, now: number): SocketInfo {
    return { id, roomId, role: 'pending', peer: -1, openedAt: now, roomCreatedAt: 0, nextPeer: 1, frames: 0, burstStart: now, burstCount: 0 };
  }

  /** 新しい接続を受け付けられるか (名乗る前の接続が多すぎれば false) */
  canAccept(): boolean {
    return this.live().filter((s) => s.info.role === 'pending').length < relayLimits.maxPendingSockets;
  }

  async onMessage(socket: RoomSocket, message: string | ArrayBuffer): Promise<void> {
    if (socket.info.role === 'closed') return;
    if (typeof message !== 'string') {
      this.closeSocket(socket, relayCloseCodes.badRequest, 'binary');
      return;
    }
    // 自動応答が使えないとき (node の確認など) の生存確認。回数に数えない
    if (message === relayPingText) {
      socket.send(relayPongText);
      return;
    }
    const now = this.env.now();
    if (isFrameTooLarge(message)) {
      this.closeSocket(socket, relayCloseCodes.tooLarge, 'too large');
      return;
    }
    if (!this.countFrame(socket, now)) {
      this.closeSocket(socket, relayCloseCodes.rateLimited, 'rate limited');
      return;
    }
    if (this.expireIfNeeded(now)) return;
    const frame = parseRelayClientFrame(message);
    if (!frame) {
      this.closeSocket(socket, relayCloseCodes.badRequest, 'bad frame');
      return;
    }
    const role = socket.info.role;
    if (role === 'pending') {
      if (frame.t === 'host') await this.hello(socket, frame.secret);
      else if (frame.t === 'join') this.join(socket, now);
      else this.closeSocket(socket, relayCloseCodes.badRequest, 'hello first');
      return;
    }
    if (role === 'host') {
      if (frame.t === 'send') {
        const target = this.guestOf(frame.to);
        if (target) this.sendFrame(target, { t: 'msg', from: 0, data: frame.data });
      } else if (frame.t === 'kick') {
        const target = this.guestOf(frame.peer);
        if (target) this.closeSocket(target, relayCloseCodes.kicked, 'kicked');
      } else {
        this.closeSocket(socket, relayCloseCodes.badRequest, 'already named');
      }
      return;
    }
    // 参加者はホストにしか送れない (宛先は無視する)
    if (frame.t === 'send') {
      const host = this.host();
      if (host) this.sendFrame(host, { t: 'msg', from: socket.info.peer, data: frame.data });
    } else {
      this.closeSocket(socket, relayCloseCodes.badRequest, 'not allowed');
    }
  }

  /** 相手が閉じた・通信が切れた */
  onClose(socket: RoomSocket): void {
    const info = socket.info;
    if (info.role === 'closed') return;
    socket.save({ ...info, role: 'closed' });
    if (info.role === 'host') {
      // ホストがいなくなったら部屋は終わり (すぐ消す)
      for (const s of this.live()) if (s.info.role === 'guest') this.closeSocket(s, relayCloseCodes.hostLeft, 'host left');
    } else if (info.role === 'guest') {
      const host = this.host();
      if (host) this.sendFrame(host, { t: 'left', peer: info.peer });
    }
  }

  /** 名乗らない接続と、寿命の過ぎた部屋を片付ける */
  onAlarm(): void {
    const now = this.env.now();
    for (const s of this.live()) {
      if (s.info.role === 'pending' && now >= s.info.openedAt + relayLimits.helloTimeoutMs) {
        this.closeSocket(s, relayCloseCodes.helloTimeout, 'hello timeout');
      }
    }
    this.expireIfNeeded(now);
  }

  /** 次に onAlarm を呼んでほしい時刻 (ms)。なければ null */
  nextAlarmAt(): number | null {
    let at = Infinity;
    for (const s of this.live()) {
      if (s.info.role === 'pending') at = Math.min(at, s.info.openedAt + relayLimits.helloTimeoutMs);
      else if (s.info.role === 'host') at = Math.min(at, s.info.roomCreatedAt + this.lifetimeMs);
    }
    return Number.isFinite(at) ? at : null;
  }

  // ------------------------------------------------------------------

  private async hello(socket: RoomSocket, secret: string): Promise<void> {
    const roomId = await roomIdOfSecret(secret);
    // ハッシュを計算している間に閉じられたかもしれない
    if (socket.info.role !== 'pending') return;
    if (roomId === null || roomId !== socket.info.roomId) {
      this.closeSocket(socket, relayCloseCodes.unauthorized, 'unauthorized');
      return;
    }
    const now = this.env.now();
    const old = this.host();
    let roomCreatedAt = now;
    let nextPeer = 1;
    if (old) {
      // 同じホストの入り直し (通信の切り替わりなど)。寿命と番号は引き継ぐ (入り直しで寿命を延ばせないように)
      roomCreatedAt = old.info.roomCreatedAt;
      nextPeer = old.info.nextPeer;
      this.closeSocket(old, relayCloseCodes.replaced, 'replaced');
      if (now >= roomCreatedAt + this.lifetimeMs) {
        this.expireRoom();
        this.closeSocket(socket, relayCloseCodes.expired, 'expired');
        return;
      }
    }
    socket.save({ ...socket.info, role: 'host', peer: 0, roomCreatedAt, nextPeer });
    this.sendFrame(socket, { t: 'ready', role: 'host', peer: 0, remainingMs: roomCreatedAt + this.lifetimeMs - now });
  }

  private join(socket: RoomSocket, now: number): void {
    const host = this.host();
    if (!host) {
      this.closeSocket(socket, relayCloseCodes.noRoom, 'no room');
      return;
    }
    const guests = this.live().filter((s) => s.info.role === 'guest').length;
    if (guests >= relayLimits.maxGuests) {
      this.closeSocket(socket, relayCloseCodes.full, 'full');
      return;
    }
    const peer = host.info.nextPeer;
    host.save({ ...host.info, nextPeer: peer + 1 });
    socket.save({ ...socket.info, role: 'guest', peer });
    const remainingMs = host.info.roomCreatedAt + this.lifetimeMs - now;
    this.sendFrame(socket, { t: 'ready', role: 'guest', peer, remainingMs });
    this.sendFrame(host, { t: 'joined', peer });
  }

  private countFrame(socket: RoomSocket, now: number): boolean {
    const info = socket.info;
    const inWindow = now - info.burstStart < relayLimits.burstWindowMs;
    const next: SocketInfo = {
      ...info,
      frames: info.frames + 1,
      burstStart: inWindow ? info.burstStart : now,
      burstCount: inWindow ? info.burstCount + 1 : 1,
    };
    socket.save(next);
    const maxFrames = info.role === 'host' ? relayLimits.maxHostFrames : relayLimits.maxGuestFrames;
    return next.frames <= maxFrames && next.burstCount <= relayLimits.burstCount;
  }

  /** 寿命が過ぎていれば部屋を閉じて true */
  private expireIfNeeded(now: number): boolean {
    const host = this.host();
    if (!host || now < host.info.roomCreatedAt + this.lifetimeMs) return false;
    this.expireRoom();
    return true;
  }

  private expireRoom(): void {
    for (const s of this.live()) if (s.info.role === 'host' || s.info.role === 'guest') this.closeSocket(s, relayCloseCodes.expired, 'expired');
  }

  private live(): RoomSocket[] {
    return this.env.sockets().filter((s) => s.info.role !== 'closed');
  }

  private host(): RoomSocket | null {
    return this.live().find((s) => s.info.role === 'host') ?? null;
  }

  private guestOf(peer: number): RoomSocket | null {
    return this.live().find((s) => s.info.role === 'guest' && s.info.peer === peer) ?? null;
  }

  private sendFrame(socket: RoomSocket, frame: RelayServerFrame): void {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // 閉じかけの接続への送信は捨てる
    }
  }

  /**
   * 先に「閉じた」にしてから閉じる (閉じたことの通知で、もう一度片付けないように)。
   * 参加者を閉じたときは、ホストに left を知らせる
   */
  private closeSocket(socket: RoomSocket, code: number, reason: string): void {
    const info = socket.info;
    if (info.role === 'closed') return;
    socket.save({ ...info, role: 'closed' });
    try {
      socket.close(code, reason);
    } catch {
      // すでに閉じている
    }
    if (info.role === 'guest') {
      const host = this.host();
      if (host) this.sendFrame(host, { t: 'left', peer: info.peer });
    }
  }
}
