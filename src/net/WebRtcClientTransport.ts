import type { ClientMessage, HostMessage } from '../shared/net/messages';
import { parseHostMessage } from '../shared/net/messages';
import type { NetClock } from '../shared/net/netClock';
import { systemClock } from '../shared/net/netClock';
import { PingSession } from '../shared/net/PingSession';
import type { NetRoute } from '../shared/net/sdp';
import { netTimings } from './netConfig';
import type { PeerLink } from './PeerLink';
import type { ClientTransport, CloseReason, TransportStats } from './Transport';

/**
 * 参加者の Transport (WebRTC)。開いた PeerLink を受け取って使う。
 * ping / pong: ホストからの ping にはすぐ pong を返し (タブが裏でも受信処理の中で返せる)、
 * 自分からも ping を送ってホスト時刻とのずれを測る。10 秒間なにも届かなければ onClose('timeout')。
 *
 * ```ts
 * link.onOpen = () => {
 *   const transport = new WebRtcClientTransport(link);
 *   transport.onEvent = (msg) => { ... };
 *   transport.sendEvent({ type: 'join', protocolVersion, name: 'KASE', team: 3 });
 * };
 * ```
 */
export class WebRtcClientTransport implements ClientTransport {
  onState: ((data: ArrayBuffer) => void) | null = null;
  onEvent: ((msg: HostMessage) => void) | null = null;
  onClose: ((reason: CloseReason) => void) | null = null;

  private readonly ping: PingSession;
  private route: NetRoute | null = null;
  private routeTimer: unknown = null;
  private isClosed = false;

  constructor(private readonly link: PeerLink, private readonly clock: NetClock = systemClock) {
    if (!link.isOpen) throw new Error('PeerLink is not open');
    this.ping = new PingSession({
      clock,
      send: (data) => link.sendState(data),
      intervalMs: netTimings.pingIntervalMs,
      burstCount: netTimings.pingBurstCount,
      burstIntervalMs: netTimings.pingBurstIntervalMs,
      timeoutMs: netTimings.peerTimeoutMs,
      onTimeout: () => this.closeWith('timeout'),
    });
    link.onState = (data) => {
      if (this.ping.handleState(data)) return;
      this.ping.markAlive();
      this.onState?.(data);
    };
    link.onEvent = (text) => {
      this.ping.markAlive();
      const msg = parseHostMessage(text);
      if (!msg) return; // 参加者は壊れたものを捨てるだけにする
      if (msg.type === 'hostClosed') {
        this.closeWith('hostClosed');
        return;
      }
      this.onEvent?.(msg);
    };
    link.onClose = () => this.closeWith('connectionFailed');
    link.onViolation = null;
    this.ping.start();
    this.refreshRoute();
  }

  get stats(): TransportStats {
    return { rttMs: this.ping.rttMs, route: this.route };
  }

  get isClockSynced(): boolean {
    return this.ping.sync.hasEstimate;
  }

  hostNow(): number {
    return this.ping.sync.toRemote(this.clock.now());
  }

  sendState(data: ArrayBuffer): void {
    if (!this.isClosed) this.link.sendState(data);
  }

  sendEvent(msg: ClientMessage): void {
    if (!this.isClosed) this.link.sendEvent(JSON.stringify(msg));
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.ping.stop();
    if (this.routeTimer !== null) this.clock.clearTimeout(this.routeTimer);
    this.link.close();
  }

  private closeWith(reason: CloseReason): void {
    if (this.isClosed) return;
    this.close();
    this.onClose?.(reason);
  }

  private refreshRoute(): void {
    this.routeTimer = null;
    if (this.isClosed) return;
    this.link.getRoute().then((route) => {
      if (route) this.route = route;
    }, () => undefined);
    this.routeTimer = this.clock.setTimeout(() => this.refreshRoute(), netTimings.routeRefreshMs);
  }
}
