import type { ClientMessage, HostMessage, PlayerId } from '../shared/net/messages';
import { parseClientMessage, parseHostMessage } from '../shared/net/messages';
import type { NetClock } from '../shared/net/netClock';
import { systemClock } from '../shared/net/netClock';
import { PingSession } from '../shared/net/PingSession';
import { eventMaxBytes, maxSlot, stateMaxBytes } from '../shared/net/protocol';
import { readStateType } from '../shared/net/stateCodec';
import { StateSequencer } from '../shared/net/StateSequencer';
import { Random } from '../shared/Random';
import { netTimings } from './netConfig';
import type { ClientTransport, CloseReason, HostTransport, PeerLeaveReason, TransportStats } from './Transport';

export interface LoopbackLinkOptions {
  /** 片道の遅延 (ms) */
  latencyMs?: number;
  /** 遅延の揺らぎ (0〜この値を足す、ms) */
  jitterMs?: number;
  /** state が失われる確率 (0〜1) */
  lossRate?: number;
}

export interface LoopbackOptions extends LoopbackLinkOptions {
  /** 省略時は実際の時計とタイマー */
  clock?: NetClock;
  /** 揺らぎ・ロスの乱数の種 */
  seed?: number;
}

export interface LoopbackClientOptions extends LoopbackLinkOptions {
  /** この参加者の時計をホストからずらす (ms)。時刻合わせの確認用 */
  clockOffsetMs?: number;
}

/**
 * 開発・確認用: 1 つのタブ (または node) の中で、ホスト 1 つと参加者を擬似的につなぐ (network.md「Transport の設計」)。
 * 片道の遅延・揺らぎ・state のロスを入れられる。event は遅れても順番どおり届き、失われない。
 *
 * ```ts
 * const net = new LoopbackNetwork({ latencyMs: 40, jitterMs: 10, lossRate: 0.05 });
 * net.host.onPeerJoin = (id) => net.host.sendEvent(id, { type: 'lobby', ... });
 * const a = net.connect({ clockOffsetMs: 1234 });   // 時計が 1.234 秒ずれた参加者
 * ```
 */
export class LoopbackNetwork {
  readonly host: LoopbackHostTransport;
  readonly clock: NetClock;
  private readonly random: Random;
  private readonly defaults: Required<LoopbackLinkOptions>;

  constructor(options: LoopbackOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.random = new Random(options.seed ?? 1);
    this.defaults = { latencyMs: options.latencyMs ?? 0, jitterMs: options.jitterMs ?? 0, lossRate: options.lossRate ?? 0 };
    this.host = new LoopbackHostTransport(this.clock);
  }

  /** 参加者を 1 人つなぐ。空いている枠 (1〜7) がなければ例外 */
  connect(options: LoopbackClientOptions = {}): LoopbackClientTransport {
    const peerId = this.host.reserveSlot();
    const link = new LoopbackLink(this.clock, this.random, {
      latencyMs: options.latencyMs ?? this.defaults.latencyMs,
      jitterMs: options.jitterMs ?? this.defaults.jitterMs,
      lossRate: options.lossRate ?? this.defaults.lossRate,
    });
    const client = new LoopbackClientTransport(this.clock, link, options.clockOffsetMs ?? 0);
    this.host.attach(peerId, client, link);
    return client;
  }
}

/** 1 人ぶんの擬似回線 (両方向) */
class LoopbackLink {
  /** event の順番を守るため、最後に届く予定の時刻を向きごとに覚える */
  private lastEventAt = [0, 0];

  constructor(private readonly clock: NetClock, private readonly random: Random, private readonly options: Required<LoopbackLinkOptions>) {}

  /** state は向きによらず、ロスと遅延だけを入れる */
  deliverState(deliver: () => void): void {
    if (this.random.chance(this.options.lossRate)) return;
    this.clock.setTimeout(deliver, this.delay());
  }

  /** direction: 0 = 参加者 → ホスト、1 = ホスト → 参加者 */
  deliverEvent(direction: number, deliver: () => void): void {
    const now = this.clock.now();
    const at = Math.max(this.lastEventAt[direction], now + this.delay());
    this.lastEventAt[direction] = at;
    this.clock.setTimeout(deliver, at - now);
  }

  private delay(): number {
    return this.options.latencyMs + this.random.next() * this.options.jitterMs;
  }
}

const toHost = 0;
const toClient = 1;

export class LoopbackClientTransport implements ClientTransport {
  onState: ((data: ArrayBuffer) => void) | null = null;
  onEvent: ((msg: HostMessage) => void) | null = null;
  onClose: ((reason: CloseReason) => void) | null = null;

  private readonly ping: PingSession;
  private readonly sequencer = new StateSequencer();
  private host: LoopbackHostTransport | null = null;
  private peerIdValue = 0;
  private isClosed = false;

  /** LoopbackNetwork.connect で作る */
  constructor(private readonly clock: NetClock, private readonly link: LoopbackLink, private readonly clockOffsetMs: number) {
    this.ping = new PingSession({
      clock,
      localNow: () => this.localNow(),
      send: (data) => this.sendRaw(data),
      intervalMs: netTimings.pingIntervalMs,
      burstCount: netTimings.pingBurstCount,
      burstIntervalMs: netTimings.pingBurstIntervalMs,
      timeoutMs: netTimings.peerTimeoutMs,
      onTimeout: () => this.closeWith('timeout'),
    });
  }

  /** ホストが割り当てた ID (枠番号) */
  get peerId(): PlayerId {
    return this.peerIdValue;
  }

  get stats(): TransportStats {
    return { rttMs: this.ping.rttMs, route: 'lan' };
  }

  get isClockSynced(): boolean {
    return this.ping.sync.hasEstimate;
  }

  /** この参加者の時計 (clockOffsetMs だけずれている) */
  localNow(): number {
    return this.clock.now() + this.clockOffsetMs;
  }

  hostNow(): number {
    return this.ping.sync.toRemote(this.localNow());
  }

  sendState(data: ArrayBuffer): void {
    if (data.byteLength > stateMaxBytes) throw new Error(`state message too large: ${data.byteLength}`);
    const copy = data.slice(0);
    this.sequencer.stamp(copy);
    this.sendRaw(copy);
  }

  sendEvent(msg: ClientMessage): void {
    const host = this.host;
    if (this.isClosed || !host) return;
    const text = JSON.stringify(msg);
    const id = this.peerIdValue;
    this.link.deliverEvent(toHost, () => host.receiveEvent(id, text));
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.ping.stop();
    const host = this.host;
    const id = this.peerIdValue;
    this.host = null;
    if (host) this.link.deliverEvent(toHost, () => host.handlePeerClosed(id, 'left'));
  }

  /** @internal ホストとつなぐ */
  attachHost(host: LoopbackHostTransport, peerId: PlayerId): void {
    this.host = host;
    this.peerIdValue = peerId;
    this.ping.start();
  }

  /** @internal ホストから届いた state */
  receiveState(data: ArrayBuffer): void {
    if (this.isClosed) return;
    if (this.ping.handleState(data)) return;
    this.ping.markAlive();
    if (readStateType(data) !== null && this.sequencer.accept(data)) this.onState?.(data);
  }

  /** @internal ホストから届いた event */
  receiveEvent(text: string): void {
    if (this.isClosed) return;
    this.ping.markAlive();
    const msg = parseHostMessage(text);
    if (!msg) return;
    if (msg.type === 'hostClosed') {
      this.closeWith('hostClosed');
      return;
    }
    this.onEvent?.(msg);
  }

  /** @internal ホスト側から切られた */
  closeWith(reason: CloseReason): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.ping.stop();
    this.host = null;
    this.onClose?.(reason);
  }

  private sendRaw(data: ArrayBuffer): void {
    const host = this.host;
    if (this.isClosed || !host) return;
    const id = this.peerIdValue;
    this.link.deliverState(() => host.receiveState(id, data));
  }
}

interface LoopbackPeer {
  client: LoopbackClientTransport;
  link: LoopbackLink;
  ping: PingSession;
  sequencer: StateSequencer;
  hasJoined: boolean;
}

export class LoopbackHostTransport implements HostTransport {
  onPeerJoin: ((peerId: PlayerId) => void) | null = null;
  onPeerLeave: ((peerId: PlayerId, reason: PeerLeaveReason) => void) | null = null;
  onState: ((peerId: PlayerId, data: ArrayBuffer) => void) | null = null;
  onEvent: ((peerId: PlayerId, msg: ClientMessage) => void) | null = null;

  private readonly peers = new Map<PlayerId, LoopbackPeer>();
  private readonly reserved = new Set<PlayerId>();

  constructor(private readonly clock: NetClock) {}

  get peerIds(): readonly PlayerId[] {
    return [...this.peers.keys()].filter((id) => this.peers.get(id)!.hasJoined);
  }

  now(): number {
    return this.clock.now();
  }

  peerStats(peerId: PlayerId): TransportStats | null {
    const peer = this.peers.get(peerId);
    return peer ? { rttMs: peer.ping.rttMs, route: 'lan' } : null;
  }

  sendState(peerId: PlayerId, data: ArrayBuffer): void {
    const peer = this.peers.get(peerId);
    if (!peer?.hasJoined) return;
    if (data.byteLength > stateMaxBytes) throw new Error(`state message too large: ${data.byteLength}`);
    const copy = data.slice(0);
    peer.sequencer.stamp(copy);
    peer.link.deliverState(() => peer.client.receiveState(copy));
  }

  broadcastState(data: ArrayBuffer): void {
    for (const id of this.peers.keys()) this.sendState(id, data);
  }

  sendEvent(peerId: PlayerId, msg: HostMessage): void {
    const peer = this.peers.get(peerId);
    if (!peer?.hasJoined) return;
    const text = JSON.stringify(msg);
    peer.link.deliverEvent(toClient, () => peer.client.receiveEvent(text));
  }

  broadcastEvent(msg: HostMessage): void {
    for (const id of this.peers.keys()) this.sendEvent(id, msg);
  }

  kick(peerId: PlayerId, reason: PeerLeaveReason): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.remove(peerId);
    peer.link.deliverEvent(toClient, () => peer.client.closeWith('connectionFailed'));
    this.onPeerLeave?.(peerId, reason);
  }

  close(): void {
    this.broadcastEvent({ type: 'hostClosed' });
    for (const id of [...this.peers.keys()]) this.remove(id);
  }

  /** @internal 空いている枠を 1 つ押さえる */
  reserveSlot(): PlayerId {
    for (let id = 1; id <= maxSlot; id++) {
      if (!this.peers.has(id) && !this.reserved.has(id)) {
        this.reserved.add(id);
        return id;
      }
    }
    throw new Error('no free slot');
  }

  /** @internal 参加者をつなぐ。遅延ぶん後に onPeerJoin */
  attach(peerId: PlayerId, client: LoopbackClientTransport, link: LoopbackLink): void {
    const ping = new PingSession({
      clock: this.clock,
      send: (data) => link.deliverState(() => client.receiveState(data)),
      intervalMs: netTimings.pingIntervalMs,
      timeoutMs: netTimings.peerTimeoutMs,
      onTimeout: () => this.handlePeerClosed(peerId, 'timeout'),
    });
    const peer: LoopbackPeer = { client, link, ping, sequencer: new StateSequencer(), hasJoined: false };
    this.peers.set(peerId, peer);
    this.reserved.delete(peerId);
    client.attachHost(this, peerId);
    link.deliverEvent(toHost, () => {
      if (this.peers.get(peerId) !== peer) return;
      peer.hasJoined = true;
      ping.start();
      this.onPeerJoin?.(peerId);
    });
  }

  /** @internal */
  receiveState(peerId: PlayerId, data: ArrayBuffer): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (data.byteLength > stateMaxBytes || readStateType(data) === null) {
      this.kick(peerId, 'kicked');
      return;
    }
    if (peer.ping.handleState(data)) return;
    peer.ping.markAlive();
    if (peer.sequencer.accept(data)) this.onState?.(peerId, data);
  }

  /** @internal */
  receiveEvent(peerId: PlayerId, text: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.ping.markAlive();
    const msg = text.length <= eventMaxBytes ? parseClientMessage(text) : null;
    if (!msg) {
      this.kick(peerId, 'kicked');
      return;
    }
    this.onEvent?.(peerId, msg);
  }

  /** @internal 参加者が抜けた・応答がない */
  handlePeerClosed(peerId: PlayerId, reason: PeerLeaveReason): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const hadJoined = peer.hasJoined;
    this.remove(peerId);
    if (reason === 'timeout') peer.link.deliverEvent(toClient, () => peer.client.closeWith('connectionFailed'));
    if (hadJoined) this.onPeerLeave?.(peerId, reason);
  }

  private remove(peerId: PlayerId): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.ping.stop();
    this.peers.delete(peerId);
  }
}
