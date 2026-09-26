import type { PeerLink } from '../net/PeerLink';
import type { RelayClientEnd } from '../net/RelayClient';
import { RelayClient } from '../net/RelayClient';
import { netTimings } from '../net/netConfig';
import { protocolVersion } from '../shared/net/protocol';
import type { RelayPayload, RelayRejectReason } from '../shared/net/relayCrypto';
import { RelayCipher } from '../shared/net/relayCrypto';
import type { RelayPeerId } from '../shared/net/relayProtocol';
import type { RoomCredentials } from '../shared/net/roomLink';
import { createRoomCredentials, roomLinkOf } from '../shared/net/roomLink';

/**
 * connecting = 中継に部屋を作っている (入り直し中も)、open = 招待リンクが使える、
 * unavailable = 中継が使えない (failure に理由。返答コード方式に切り替える)、closed = closeRoom した
 */
export type HostRoomState = 'connecting' | 'open' | 'unavailable' | 'closed';

/**
 * relayUnavailable = 中継につながらない (未設定・止まっている・ネットワーク)、expired = 部屋の期限 (30 分) 切れ、
 * replaced = 同じ部屋に別のタブがホストとして入った、relayError = 中継が接続を切った (上限など)、
 * lost = つながったあとに切れ、入り直しにも失敗した
 */
export type HostRoomFailure = 'relayUnavailable' | 'expired' | 'replaced' | 'relayError' | 'lost';

/** ホストの画面に出す中継の部屋の状態 */
export interface HostRoomView {
  state: HostRoomState;
  /** 全員共通の招待リンク (open のときだけ。connecting でも入り直し中なら前のリンクのまま使える) */
  link: string | null;
  /** 部屋の期限までの残り (ms、open のときだけ) */
  remainingMs: number | null;
  failure: HostRoomFailure | null;
}

/** 中継経由の参加者の offer への答え */
export type RelayAnswerResult = { ok: true; link: PeerLink; sdp: string; slot: number } | { ok: false; reason: RelayRejectReason };

/** HostRoom が HostLobby に頼むこと */
export interface HostRoomDelegate {
  readonly lobbyId: number;
  /** 空いている枠を割り当てて answer を作る。枠がなければ full、ロビーを閉じていれば closed */
  answerOffer(offerSdp: string): Promise<RelayAnswerResult>;
  /** 参加者がやめた (bye)。まだ開いていなければその枠を空ける */
  abandon(link: PeerLink): void;
  onChange(): void;
}

interface RelayPeer {
  /** 最初の offer の sid (その参加者の接続の試み)。offer が来るまで null */
  sid: string | null;
  link: PeerLink | null;
  queue: Promise<void>;
}

/** 覚えておく sid の数の上限 (同じ offer の再送を拒否するため。部屋の寿命の間に届く数よりずっと多い) */
const maxSeenSids = 1000;

/**
 * ホストの中継の部屋 (network.md「中継による接続」)。部屋を作って全員共通の招待リンクを出し、
 * 中継経由で届いた参加者の offer に HostLobby が割り当てた枠で答える (trickle ICE)。
 * 中継に入れないとき・切れたときは state が unavailable になる (HostLobby の従来の招待・返答コードはそのまま使える)。
 * 通信の切り替わりなどで切れたときは、同じ部屋 (同じリンク) に 3 回まで入り直す。
 */
export class HostRoom {
  private stateValue: HostRoomState = 'connecting';
  private failureValue: HostRoomFailure | null = null;
  private credentials: RoomCredentials | null = null;
  private cipher: RelayCipher | null = null;
  private relay: RelayClient | null = null;
  private linkValue: string | null = null;
  /** performance.now() の ms */
  private expiresAt = 0;
  private reconnects = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly peers = new Map<RelayPeerId, RelayPeer>();
  private readonly seenSids = new Set<string>();
  private sendQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly pageUrl: string, private readonly url: string | null, private readonly delegate: HostRoomDelegate) {}

  /** 部屋を作り始める。pageUrl は招待リンクの元にするページの URL (origin + pathname) */
  static open(pageUrl: string, url: string | null, delegate: HostRoomDelegate): HostRoom {
    const room = new HostRoom(pageUrl, url, delegate);
    void room.start();
    return room;
  }

  get view(): HostRoomView {
    const isOpen = this.stateValue === 'open';
    const isReconnecting = this.stateValue === 'connecting' && this.reconnects > 0;
    return {
      state: this.stateValue,
      link: isOpen || isReconnecting ? this.linkValue : null,
      remainingMs: isOpen ? Math.max(0, this.expiresAt - performance.now()) : null,
      failure: this.failureValue,
    };
  }

  /** 中継の参加者を外す (中継の接続を切る。WebRTC の接続は HostLobby が閉じる) */
  kickRelayPeerOf(link: PeerLink): void {
    for (const [peer, p] of this.peers) {
      if (p.link === link) {
        this.relay?.send({ t: 'kick', peer });
        this.peers.delete(peer);
      }
    }
  }

  /** 部屋を閉じる (招待リンクは使えなくなる。つながっている参加者はそのまま) */
  close(): void {
    if (this.stateValue === 'closed') return;
    this.stateValue = 'closed';
    this.failureValue = null;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.relay?.close();
    this.relay = null;
    this.peers.clear();
    this.delegate.onChange();
  }

  // ------------------------------------------------------------------

  private async start(): Promise<void> {
    if (!this.url) {
      this.setUnavailable('relayUnavailable');
      return;
    }
    const credentials = await createRoomCredentials();
    const cipher = await RelayCipher.create(credentials.roomId, credentials.key);
    if (this.stateValue !== 'connecting') return;
    if (!cipher) {
      this.setUnavailable('relayUnavailable');
      return;
    }
    this.credentials = credentials;
    this.cipher = cipher;
    this.linkValue = roomLinkOf(this.pageUrl, credentials);
    this.connect();
  }

  private connect(): void {
    const credentials = this.credentials;
    if (!credentials || !this.url) return;
    const relay = RelayClient.connect(this.url, credentials.roomId, { t: 'host', secret: credentials.secret });
    this.relay = relay;
    relay.onReady = (frame) => {
      if (this.relay !== relay) return;
      this.reconnects = 0;
      this.stateValue = 'open';
      this.failureValue = null;
      this.expiresAt = performance.now() + frame.remainingMs;
      this.delegate.onChange();
    };
    relay.onFrame = (frame) => {
      if (this.relay !== relay) return;
      if (frame.t === 'joined') this.peers.set(frame.peer, { sid: null, link: null, queue: Promise.resolve() });
      else if (frame.t === 'left') this.peers.delete(frame.peer);
      else if (frame.t === 'msg') this.enqueue(frame.from, frame.data);
    };
    relay.onEnd = (end) => {
      if (this.relay === relay) this.handleEnd(end);
    };
  }

  private handleEnd(end: RelayClientEnd): void {
    this.relay = null;
    // 中継の参加者の番号は接続ごとのもの。入り直したら使えない (つながりかけの WebRTC はそのまま続く)
    this.peers.clear();
    const wasOpen = this.stateValue === 'open' || this.reconnects > 0;
    if (end === 'expired') {
      this.setUnavailable('expired');
    } else if (end === 'replaced') {
      this.setUnavailable('replaced');
    } else if ((end === 'lost' || end === 'unreachable') && wasOpen && this.reconnects < netTimings.relayReconnectAttempts) {
      this.reconnects++;
      this.stateValue = 'connecting';
      this.delegate.onChange();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.stateValue === 'connecting') this.connect();
      }, netTimings.relayReconnectDelayMs);
    } else if (end === 'unreachable') {
      this.setUnavailable(wasOpen ? 'lost' : 'relayUnavailable');
    } else {
      this.setUnavailable(end === 'lost' ? 'lost' : 'relayError');
    }
  }

  private setUnavailable(failure: HostRoomFailure): void {
    if (this.stateValue === 'closed') return;
    this.stateValue = 'unavailable';
    this.failureValue = failure;
    this.relay?.close();
    this.relay = null;
    this.delegate.onChange();
  }

  /** 参加者ごとに届いた順に処理する (answer を作る前に候補を加えない) */
  private enqueue(from: RelayPeerId, data: string): void {
    const peer = this.peers.get(from);
    if (!peer) return;
    peer.queue = peer.queue.then(() => this.receive(from, peer, data)).catch(() => undefined);
  }

  private async receive(from: RelayPeerId, peer: RelayPeer, data: string): Promise<void> {
    const cipher = this.cipher;
    if (!cipher || this.stateValue === 'closed') return;
    const r = await cipher.open('toHost', data);
    if (!r.ok || this.peers.get(from) !== peer) return;
    const p = r.payload;
    if (p.type === 'offer') {
      // 1 本の中継の接続につき offer は 1 回。同じ sid の再送 (中継や第三者が繰り返したもの) は答えない
      if (peer.sid !== null || this.seenSids.has(p.sid)) return;
      peer.sid = p.sid;
      this.rememberSid(p.sid);
      if (p.pv !== protocolVersion) {
        this.send(from, { type: 'reject', sid: p.sid, reason: 'version', pv: protocolVersion });
        return;
      }
      const answer = await this.delegate.answerOffer(p.sdp);
      if (!answer.ok) {
        this.send(from, { type: 'reject', sid: p.sid, reason: answer.reason, pv: protocolVersion });
        return;
      }
      if (this.peers.get(from) !== peer) {
        // answer を作っている間に参加者が抜けた。枠は WebRTC の時間切れで空く
        return;
      }
      peer.link = answer.link;
      const sid = p.sid;
      this.send(from, { type: 'answer', sid, lobbyId: this.delegate.lobbyId, slot: answer.slot, sdp: answer.sdp });
      answer.link.setLocalCandidateHandler((c) => {
        if (this.peers.get(from) === peer) this.send(from, { type: 'cand', sid, c });
      });
      return;
    }
    // offer の相手と同じ試み (sid) のものだけ受け付ける
    if (peer.sid === null || p.sid !== peer.sid) return;
    if (p.type === 'cand') {
      if (peer.link) await peer.link.addRemoteCandidate(p.c);
    } else if (p.type === 'bye') {
      if (peer.link && !peer.link.isOpen) this.delegate.abandon(peer.link);
      peer.link = null;
    }
  }

  /** 暗号化して参加者へ送る (送る順を守る) */
  private send(to: RelayPeerId, payload: RelayPayload): void {
    const cipher = this.cipher;
    const relay = this.relay;
    if (!cipher || !relay) return;
    this.sendQueue = this.sendQueue.then(async () => {
      const data = await cipher.seal('toGuest', payload);
      relay.send({ t: 'send', to, data });
    }).catch(() => undefined);
  }

  private rememberSid(sid: string): void {
    if (this.seenSids.size >= maxSeenSids) {
      const first = this.seenSids.values().next();
      if (!first.done) this.seenSids.delete(first.value);
    }
    this.seenSids.add(sid);
  }
}
