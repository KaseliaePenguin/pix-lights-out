import { netTimings } from '../net/netConfig';
import type { HostTransport, PeerLeaveReason, TransportStats } from '../net/Transport';
import type { ClientMessage, HostMessage, PlayerId } from '../shared/net/messages';
import { parseClientMessage } from '../shared/net/messages';
import type { NetClock } from '../shared/net/netClock';
import { systemClock } from '../shared/net/netClock';
import { PingSession } from '../shared/net/PingSession';
import { eventMaxBytes, stateMaxBytes } from '../shared/net/protocol';
import type { NetRoute } from '../shared/net/sdp';
import { readStateType } from '../shared/net/stateCodec';
import type { FromWorkerMessage, LocalPortMessage, ToWorkerMessage } from './workerProtocol';

/** Worker からメインスレッドへ送る関数 (transfer に渡した ArrayBuffer は転送される) */
export type PostToMain = (msg: FromWorkerMessage, transfer?: Transferable[]) => void;

interface WorkerPeer {
  ping: PingSession;
  route: NetRoute | null;
  /** ホスト本人 (MessagePort でつながる) */
  port: MessagePort | null;
}

/** ホスト本人の枠 */
const localPeerId: PlayerId = 0;

/**
 * ホストの Worker の中の HostTransport (network.md「Transport の設計」)。
 * 参加者 (枠 1〜7) とはメインスレッドの HostRelay 経由 (postMessage)、ホスト本人 (枠 0) とは LocalTransport と
 * つながる MessagePort で話す。ping (1 回/秒) と 10 秒 pong なしの切断は、間引かれない Worker のタイマーで行う。
 * 受信の形・大きさを確かめ、不正なものを送った相手は切断する。
 */
export class WorkerHostTransport implements HostTransport {
  onPeerJoin: ((peerId: PlayerId) => void) | null = null;
  onPeerLeave: ((peerId: PlayerId, reason: PeerLeaveReason) => void) | null = null;
  onState: ((peerId: PlayerId, data: ArrayBuffer) => void) | null = null;
  onEvent: ((peerId: PlayerId, msg: ClientMessage) => void) | null = null;

  private readonly peers = new Map<PlayerId, WorkerPeer>();
  private isClosed = false;

  constructor(private readonly post: PostToMain, private readonly clock: NetClock = systemClock) {}

  get peerIds(): readonly PlayerId[] {
    return [...this.peers.keys()];
  }

  now(): number {
    return this.clock.now();
  }

  peerStats(peerId: PlayerId): TransportStats | null {
    const peer = this.peers.get(peerId);
    return peer ? { rttMs: peer.ping.rttMs, route: peer.route } : null;
  }

  /** ホスト本人のゲームとつなぐ (init で 1 回) */
  attachLocal(port: MessagePort): void {
    port.onmessage = (e: MessageEvent<LocalPortMessage>) => {
      const msg = e.data;
      if (msg.kind === 'state') this.receiveState(localPeerId, msg.data);
      else if (msg.kind === 'event') this.receiveEvent(localPeerId, msg.text);
      else this.handlePeerClosed(localPeerId, 'left');
    };
    this.addPeer(localPeerId, null, port);
  }

  /** メインスレッド (HostRelay) から届いた、参加者に関するメッセージ。扱ったら true */
  handleMainMessage(msg: ToWorkerMessage): boolean {
    switch (msg.kind) {
      case 'peerOpen':
        this.addPeer(msg.peerId, msg.route, null);
        return true;
      case 'peerRoute': {
        const peer = this.peers.get(msg.peerId);
        if (peer) peer.route = msg.route;
        return true;
      }
      case 'peerClosed':
        this.handlePeerClosed(msg.peerId, msg.reason);
        return true;
      case 'state':
        this.receiveState(msg.peerId, msg.data);
        return true;
      case 'event':
        this.receiveEvent(msg.peerId, msg.text);
        return true;
      case 'violation':
      case 'kickPeer':
        // ホスト本人 (枠 0) は外さない
        if (msg.peerId !== localPeerId && this.peers.has(msg.peerId)) this.kick(msg.peerId, 'kicked');
        return true;
      default:
        return false;
    }
  }

  sendState(peerId: PlayerId, data: ArrayBuffer): void {
    const peer = this.peers.get(peerId);
    if (!peer || this.isClosed) return;
    if (data.byteLength > stateMaxBytes) throw new Error(`state message too large: ${data.byteLength}`);
    this.sendStateTo(peerId, peer, data);
  }

  broadcastState(data: ArrayBuffer): void {
    if (this.isClosed) return;
    if (data.byteLength > stateMaxBytes) throw new Error(`state message too large: ${data.byteLength}`);
    const local = this.peers.get(localPeerId);
    if (local) this.sendStateTo(localPeerId, local, data);
    if ([...this.peers.keys()].some((id) => id !== localPeerId)) {
      const copy = data.slice(0);
      this.post({ kind: 'state', peerId: null, data: copy }, [copy]);
    }
  }

  sendEvent(peerId: PlayerId, msg: HostMessage): void {
    const peer = this.peers.get(peerId);
    if (!peer || this.isClosed) return;
    this.sendText(peerId, peer, JSON.stringify(msg));
  }

  broadcastEvent(msg: HostMessage): void {
    if (this.isClosed) return;
    const text = JSON.stringify(msg);
    const local = this.peers.get(localPeerId);
    if (local) this.sendText(localPeerId, local, text);
    if ([...this.peers.keys()].some((id) => id !== localPeerId)) this.post({ kind: 'event', peerId: null, text });
  }

  kick(peerId: PlayerId, reason: PeerLeaveReason): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.removePeer(peerId);
    if (peer.port) peer.port.postMessage({ kind: 'close' } satisfies LocalPortMessage);
    else this.post({ kind: 'kick', peerId, reason });
    this.onPeerLeave?.(peerId, reason);
  }

  close(): void {
    if (this.isClosed) return;
    this.broadcastEvent({ type: 'hostClosed' });
    this.isClosed = true;
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.post({ kind: 'closeAll' });
  }

  private addPeer(peerId: PlayerId, route: NetRoute | null, port: MessagePort | null): void {
    if (this.isClosed || this.peers.has(peerId)) return;
    const ping = new PingSession({
      clock: this.clock,
      send: (data) => {
        const p = this.peers.get(peerId);
        if (p) this.sendStateTo(peerId, p, data);
      },
      intervalMs: netTimings.pingIntervalMs,
      timeoutMs: netTimings.peerTimeoutMs,
      onTimeout: () => this.kick(peerId, 'timeout'),
    });
    this.peers.set(peerId, { ping, route, port });
    ping.start();
    this.onPeerJoin?.(peerId);
  }

  private removePeer(peerId: PlayerId): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.ping.stop();
    this.peers.delete(peerId);
  }

  private handlePeerClosed(peerId: PlayerId, reason: PeerLeaveReason): void {
    if (!this.peers.has(peerId)) return;
    this.removePeer(peerId);
    this.onPeerLeave?.(peerId, reason);
  }

  /** data は呼び出し側が使い続けるので、複製を転送する */
  private sendStateTo(peerId: PlayerId, peer: WorkerPeer, data: ArrayBuffer): void {
    const copy = data.slice(0);
    if (peer.port) peer.port.postMessage({ kind: 'state', data: copy } satisfies LocalPortMessage, [copy]);
    else this.post({ kind: 'state', peerId, data: copy }, [copy]);
  }

  private sendText(peerId: PlayerId, peer: WorkerPeer, text: string): void {
    if (peer.port) peer.port.postMessage({ kind: 'event', text } satisfies LocalPortMessage);
    else this.post({ kind: 'event', peerId, text });
  }

  private receiveState(peerId: PlayerId, data: unknown): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (!(data instanceof ArrayBuffer) || data.byteLength > stateMaxBytes || readStateType(data) === null) {
      this.kick(peerId, 'kicked');
      return;
    }
    if (peer.ping.handleState(data)) return;
    peer.ping.markAlive();
    this.onState?.(peerId, data);
  }

  private receiveEvent(peerId: PlayerId, text: unknown): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.ping.markAlive();
    const msg = typeof text === 'string' && text.length <= eventMaxBytes ? parseClientMessage(text) : null;
    if (!msg) {
      this.kick(peerId, 'kicked');
      return;
    }
    this.onEvent?.(peerId, msg);
  }
}
