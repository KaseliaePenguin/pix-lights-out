import type { LinkCloseReason, PeerLink } from '../net/PeerLink';
import { netTimings } from '../net/netConfig';
import type { PeerLeaveReason } from '../net/Transport';
import type { PlayerId } from '../shared/net/messages';
import type { FromWorkerMessage, ToWorkerMessage } from './workerProtocol';

/** Worker の、中継に使う部分 (確認用に差し替えられるよう、形だけを決める) */
export interface WorkerPort {
  postMessage(msg: ToWorkerMessage, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<FromWorkerMessage>) => void) | null;
}

/** closed / failed / timeout = PeerLink が閉じた、kicked = Worker が切断した */
export type RelayLinkEndReason = LinkCloseReason | 'kicked';

/** hostClosed を送ってから接続を閉じるまでの時間 (ms)。送信待ちの hostClosed が相手に届くように待つ */
const closeAllDelayMs = 300;

const hostClosedText = JSON.stringify({ type: 'hostClosed' });

/**
 * ホストのメインスレッドの中継 (network.md「全体構成」)。参加者の PeerLink (DataChannel 2 本) と Worker の間で、
 * 届いたものをそのまま渡す。タイマーを持たず、すべて受信のイベントで動く (タブが裏に回って間引かれても遅れない)。
 * 接続経路 (LAN / NET) の再確認も、その参加者から状態が届いたときに 5 秒以上たっていれば行う。
 * HostLobby が使う。
 */
export class HostRelay {
  /** 参加者の DataChannel が開いた */
  onLinkOpen: ((peerId: PlayerId) => void) | null = null;
  /** 参加者の接続が終わった (開く前の失敗も含む) */
  onLinkEnd: ((peerId: PlayerId, reason: RelayLinkEndReason) => void) | null = null;
  /** 中継以外の Worker からのメッセージ (status・startResult・warning) */
  onWorkerMessage: ((msg: FromWorkerMessage) => void) | null = null;

  private readonly links = new Map<PlayerId, PeerLink>();
  private readonly routeCheckedAt = new Map<PlayerId, number>();

  constructor(private readonly worker: WorkerPort) {
    worker.onmessage = (e) => this.handleWorker(e.data);
  }

  /** 招待を出した枠の PeerLink を登録する。開いたら Worker に知らせ、以降の受信を渡す */
  addLink(peerId: PlayerId, link: PeerLink): void {
    this.links.get(peerId)?.close();
    this.links.set(peerId, link);
    link.onOpen = () => {
      this.worker.postMessage({ kind: 'peerOpen', peerId, route: null });
      this.onLinkOpen?.(peerId);
      this.refreshRoute(peerId, link, true);
    };
    link.onState = (data) => {
      this.worker.postMessage({ kind: 'state', peerId, data }, [data]);
      this.refreshRoute(peerId, link, false);
    };
    link.onEvent = (text) => this.worker.postMessage({ kind: 'event', peerId, text });
    link.onViolation = () => this.worker.postMessage({ kind: 'violation', peerId });
    link.onClose = (reason) => {
      if (this.links.get(peerId) !== link) return;
      this.links.delete(peerId);
      const leave: PeerLeaveReason = reason === 'closed' ? 'left' : reason === 'timeout' ? 'timeout' : 'connectionFailed';
      // 開く前に閉じた枠は Worker が知らないので、Worker 側で無視される
      this.worker.postMessage({ kind: 'peerClosed', peerId, reason: leave });
      this.onLinkEnd?.(peerId, reason);
    };
  }

  /** 枠の接続を閉じる (招待の取り消しなど)。Worker にも切断として知らせる */
  removeLink(peerId: PlayerId): void {
    const link = this.links.get(peerId);
    if (!link) return;
    this.links.delete(peerId);
    link.close();
    this.worker.postMessage({ kind: 'peerClosed', peerId, reason: 'kicked' });
  }

  /** 開いている参加者がいるか (beforeunload の確認用) */
  get hasOpenLinks(): boolean {
    for (const link of this.links.values()) if (link.isOpen) return true;
    return false;
  }

  /**
   * Worker を待たずに、開いている全員へ hostClosed を送る (pagehide など、Worker が動く前にページが閉じるとき用)
   */
  sendHostClosedNow(): void {
    for (const link of this.links.values()) if (link.isOpen) link.sendEvent(hostClosedText);
  }

  private handleWorker(msg: FromWorkerMessage): void {
    switch (msg.kind) {
      case 'state':
        if (msg.peerId === null) {
          // PeerLink.sendState は連番を書き換えてから送る (send はその時点の内容を送る) ので、同じバッファを使い回せる
          for (const link of this.links.values()) if (link.isOpen) link.sendState(msg.data);
        } else {
          const link = this.links.get(msg.peerId);
          if (link?.isOpen) link.sendState(msg.data);
        }
        break;
      case 'event':
        if (msg.peerId === null) {
          for (const link of this.links.values()) if (link.isOpen) link.sendEvent(msg.text);
        } else {
          const link = this.links.get(msg.peerId);
          if (link?.isOpen) link.sendEvent(msg.text);
        }
        break;
      case 'kick': {
        const link = this.links.get(msg.peerId);
        if (!link) break;
        this.links.delete(msg.peerId);
        link.close();
        this.onLinkEnd?.(msg.peerId, 'kicked');
        break;
      }
      case 'closeAll': {
        const links = [...this.links.entries()];
        this.links.clear();
        // 終了のときだけの 1 回きりの待ち。hostClosed が送信待ちのまま接続を閉じないようにする
        setTimeout(() => {
          for (const [peerId, link] of links) {
            link.close();
            this.onLinkEnd?.(peerId, 'closed');
          }
        }, closeAllDelayMs);
        break;
      }
      default:
        this.onWorkerMessage?.(msg);
        break;
    }
  }

  private refreshRoute(peerId: PlayerId, link: PeerLink, force: boolean): void {
    const now = performance.now();
    const last = this.routeCheckedAt.get(peerId) ?? -Infinity;
    if (!force && now - last < netTimings.routeRefreshMs) return;
    this.routeCheckedAt.set(peerId, now);
    link.getRoute().then((route) => {
      if (route && this.links.get(peerId) === link) this.worker.postMessage({ kind: 'peerRoute', peerId, route });
    }, () => undefined);
  }
}
