import type { LocalPortMessage } from '../host/workerProtocol';
import type { ClientMessage, HostMessage } from '../shared/net/messages';
import { parseHostMessage } from '../shared/net/messages';
import type { NetClock } from '../shared/net/netClock';
import { systemClock } from '../shared/net/netClock';
import { PingSession } from '../shared/net/PingSession';
import { stateMaxBytes } from '../shared/net/protocol';
import { readStateType } from '../shared/net/stateCodec';
import { netTimings } from './netConfig';
import type { ClientTransport, CloseReason, TransportStats } from './Transport';

/**
 * ホスト本人のゲームの Transport (network.md「全体構成」)。ホストの Worker と MessagePort でつながり、
 * ネットワーク越しの参加者と同じメッセージ形式で話す (処理を 1 通りにするため)。遅延はほぼ 0。
 * Worker の時計 (ホスト時刻) とメインスレッドの時計は基準が違いうるので、参加者と同じく ping / pong で合わせる。
 * HostLobby が作る。
 */
export class LocalTransport implements ClientTransport {
  onState: ((data: ArrayBuffer) => void) | null = null;
  onEvent: ((msg: HostMessage) => void) | null = null;
  onClose: ((reason: CloseReason) => void) | null = null;

  private readonly ping: PingSession;
  private isClosed = false;

  constructor(private readonly port: MessagePort, private readonly clock: NetClock = systemClock) {
    this.ping = new PingSession({
      clock,
      send: (data) => this.post({ kind: 'state', data }, [data]),
      intervalMs: netTimings.pingIntervalMs,
      burstCount: netTimings.pingBurstCount,
      burstIntervalMs: netTimings.pingBurstIntervalMs,
      timeoutMs: netTimings.peerTimeoutMs,
      onTimeout: () => this.closeWith('timeout'),
    });
    port.onmessage = (e: MessageEvent<LocalPortMessage>) => this.receive(e.data);
    this.ping.start();
  }

  get stats(): TransportStats {
    return { rttMs: this.ping.rttMs, route: null };
  }

  get isClockSynced(): boolean {
    return this.ping.sync.hasEstimate;
  }

  hostNow(): number {
    return this.ping.sync.toRemote(this.clock.now());
  }

  sendState(data: ArrayBuffer): void {
    if (this.isClosed) return;
    if (data.byteLength > stateMaxBytes) throw new Error(`state message too large: ${data.byteLength}`);
    const copy = data.slice(0);
    this.post({ kind: 'state', data: copy }, [copy]);
  }

  sendEvent(msg: ClientMessage): void {
    if (!this.isClosed) this.post({ kind: 'event', text: JSON.stringify(msg) });
  }

  close(): void {
    if (this.isClosed) return;
    this.post({ kind: 'close' });
    this.isClosed = true;
    this.ping.stop();
    this.port.close();
  }

  private post(msg: LocalPortMessage, transfer: Transferable[] = []): void {
    this.port.postMessage(msg, transfer);
  }

  private receive(msg: LocalPortMessage): void {
    if (this.isClosed) return;
    this.ping.markAlive();
    if (msg.kind === 'state') {
      if (!(msg.data instanceof ArrayBuffer) || msg.data.byteLength > stateMaxBytes || readStateType(msg.data) === null) return;
      if (!this.ping.handleState(msg.data)) this.onState?.(msg.data);
    } else if (msg.kind === 'event') {
      const parsed = parseHostMessage(msg.text);
      if (!parsed) return;
      if (parsed.type === 'hostClosed') this.closeWith('hostClosed');
      else this.onEvent?.(parsed);
    } else {
      this.closeWith('connectionFailed');
    }
  }

  private closeWith(reason: CloseReason): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.ping.stop();
    this.port.close();
    this.onClose?.(reason);
  }
}
