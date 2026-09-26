import { protocolVersion } from '../shared/net/protocol';
import type { RelayPayload } from '../shared/net/relayCrypto';
import { createRelaySessionId, RelayCipher } from '../shared/net/relayCrypto';
import type { RoomLink } from '../shared/net/roomLink';
import { netTimings, signalingUrl } from './netConfig';
import type { LinkDiagnostics } from './PeerLink';
import { PeerLink } from './PeerLink';
import type { RelayClientEnd } from './RelayClient';
import { RelayClient } from './RelayClient';
import { WebRtcClientTransport } from './WebRtcClientTransport';

/**
 * connecting = 中継につないでいる (最大 6 秒)、waitingHost = offer を送ってホストの answer を待っている (最大 10 秒)、
 * connectingPeer = answer を受け取り、WebRTC の接続を待っている (最大 20 秒)、open = つながった (onOpen 済み)、
 * failed = 失敗 (failure に理由)、cancelled = cancel した
 */
export type GuestRoomPhase = 'connecting' | 'waitingHost' | 'connectingPeer' | 'open' | 'failed' | 'cancelled';

/**
 * relayUnavailable = 中継につながらない (未設定・止まっている・ネットワーク・Origin の拒否)、
 * noRoom = 部屋がない (ホストがロビーを閉じた・ホストのタブが閉じた・30 分の期限切れ)、full = 満員、
 * version = ゲームのバージョン違い (theirVersion にホストのバージョン)、timeout = ホストから返事がない、
 * connectionFailed = WebRTC がつながらない (ICE・DTLS の失敗、20 秒で開かない)、
 * relayError = 中継が接続を切った (送信回数・サイズの上限、壊れた返事)、invalidLink = 招待リンクが壊れている
 */
export type GuestRoomFailure = 'relayUnavailable' | 'noRoom' | 'full' | 'version' | 'timeout' | 'connectionFailed' | 'relayError' | 'invalidLink';

/**
 * この失敗のあと、従来の招待リンク (#join=、返答コード方式) に切り替えるべきか。
 * 中継や部屋の問題なら true (ホストに従来の招待リンクを頼めばつながる見込みがある)。
 * 満員・バージョン違い・WebRTC の失敗は方式を変えても同じなので false
 */
export function shouldFallbackToCode(failure: GuestRoomFailure): boolean {
  return failure === 'relayUnavailable' || failure === 'noRoom' || failure === 'timeout' || failure === 'relayError';
}

export interface GuestRoomOptions {
  /** 中継の URL (既定は netConfig の signalingUrl()。null なら中継を使わず、すぐ relayUnavailable で失敗する) */
  url?: string | null;
}

/**
 * 参加者の中継経由の接続 (network.md「中継による接続」)。招待リンク (#room=) を開いたら join を呼ぶだけで、
 * 中継に入る → offer を送る → ホストの answer を受け取る → WebRTC がつながる、まで自動で進む。返答コードはない。
 * 失敗したら onFail。shouldFallbackToCode(failure) が true なら、従来の方式 (GuestConnector) に切り替える案内を出す。
 *
 * ```ts
 * const link = roomLinkFromHash(location.hash);
 * if (link) {
 *   const c = GuestRoomConnector.join(link);
 *   c.onChange = () => redraw();                 // c.phase で「中継に接続中」「ホストの応答待ち」などを出す
 *   c.onOpen = (transport) => { const session = new NetClientSession(transport, profile, track); };
 *   c.onFail = (failure) => shouldFallbackToCode(failure) ? showPasteInvite() : showFailure(failure, c.diagnostics());
 * }
 * ```
 */
export class GuestRoomConnector {
  onOpen: ((transport: WebRtcClientTransport) => void) | null = null;
  onFail: ((failure: GuestRoomFailure) => void) | null = null;
  /** phase が変わった */
  onChange: (() => void) | null = null;

  private phaseValue: GuestRoomPhase = 'connecting';
  private failureValue: GuestRoomFailure | null = null;
  private theirVersionValue: number | null = null;
  private slotValue: number | null = null;
  private readonly sid = createRelaySessionId();
  private cipher: RelayCipher | null = null;
  private relay: RelayClient | null = null;
  private link: PeerLink | null = null;
  private offerSdp: string | null = null;
  private isOfferSent = false;
  private hasAnswer = false;
  private answerTimer: ReturnType<typeof setTimeout> | null = null;
  /** 送信・受信は順に処理する (offer より先に候補を送らない、answer より先に候補を加えない) */
  private sendQueue: Promise<void> = Promise.resolve();
  private receiveQueue: Promise<void> = Promise.resolve();
  private lastDiagnostics: LinkDiagnostics | null = null;

  private constructor(private readonly room: RoomLink, private readonly url: string | null) {}

  /** 招待リンク (#room=) の部屋に入る。すぐに接続を始める */
  static join(room: RoomLink, options: GuestRoomOptions = {}): GuestRoomConnector {
    const url = options.url === undefined ? signalingUrl() : options.url;
    const c = new GuestRoomConnector(room, url);
    void c.start();
    return c;
  }

  get phase(): GuestRoomPhase {
    return this.phaseValue;
  }

  get failure(): GuestRoomFailure | null {
    return this.failureValue;
  }

  /** version で失敗したときのホストのバージョン */
  get theirVersion(): number | null {
    return this.theirVersionValue;
  }

  /** ホストが割り当てた枠 (answer を受け取るまで null) */
  get slot(): number | null {
    return this.slotValue;
  }

  /** [詳細をコピー] 用の記録 (IP アドレスを含まない)。WebRTC を始める前に失敗したときは null */
  diagnostics(): LinkDiagnostics | null {
    return this.link ? this.link.getDiagnostics() : this.lastDiagnostics;
  }

  /** やめる。つながる前なら、ホストに bye を送って閉じる */
  cancel(): void {
    if (this.phaseValue === 'open' || this.phaseValue === 'failed' || this.phaseValue === 'cancelled') return;
    if (this.isOfferSent) this.post({ type: 'bye', sid: this.sid });
    const relay = this.relay;
    // bye を送り終えてから閉じる
    void this.sendQueue.then(() => relay?.close());
    this.relay = null;
    this.link?.close();
    this.link = null;
    this.clearAnswerTimer();
    this.setPhase('cancelled');
  }

  // ------------------------------------------------------------------

  private async start(): Promise<void> {
    if (!this.url) {
      this.fail('relayUnavailable');
      return;
    }
    const cipher = await RelayCipher.create(this.room.roomId, this.room.key);
    if (!this.isActive) return;
    if (!cipher) {
      this.fail('invalidLink');
      return;
    }
    this.cipher = cipher;
    const relay = RelayClient.connect(this.url, this.room.roomId, { t: 'join' });
    this.relay = relay;
    relay.onReady = () => this.trySendOffer();
    relay.onFrame = (frame) => {
      if (frame.t === 'msg' && frame.from === 0) this.enqueueReceive(frame.data);
    };
    relay.onEnd = (end) => this.handleRelayEnd(end);
    // 中継につないでいる間に offer を作る (候補の収集も並行して進む)
    try {
      const offer = await PeerLink.createRelayOffer();
      if (!this.isActive) {
        offer.link.close();
        return;
      }
      this.link = offer.link;
      this.offerSdp = offer.sdp;
      offer.link.onOpen = () => this.handleOpen(offer.link);
      offer.link.onClose = (reason) => {
        if (this.link !== offer.link) return;
        this.lastDiagnostics = offer.link.getDiagnostics();
        this.fail(reason === 'timeout' && !this.hasAnswer ? 'timeout' : 'connectionFailed');
      };
      this.trySendOffer();
    } catch {
      this.fail('connectionFailed');
    }
  }

  private get isActive(): boolean {
    return this.phaseValue === 'connecting' || this.phaseValue === 'waitingHost' || this.phaseValue === 'connectingPeer';
  }

  /** 中継の名乗りが通り、offer ができたら送る (どちらが先でもよい) */
  private trySendOffer(): void {
    const link = this.link;
    if (this.isOfferSent || !this.isActive || !this.relay?.isReady || !link || !this.offerSdp) return;
    this.isOfferSent = true;
    this.post({ type: 'offer', sid: this.sid, pv: protocolVersion, sdp: this.offerSdp });
    link.setLocalCandidateHandler((c) => this.post({ type: 'cand', sid: this.sid, c }));
    this.answerTimer = setTimeout(() => {
      if (!this.hasAnswer) this.fail('timeout');
    }, netTimings.relayAnswerWaitMs);
    this.setPhase('waitingHost');
  }

  /** 暗号化してホストへ送る (送る順を守る) */
  private post(payload: RelayPayload): void {
    const cipher = this.cipher;
    const relay = this.relay;
    if (!cipher || !relay) return;
    this.sendQueue = this.sendQueue.then(async () => {
      const data = await cipher.seal('toHost', payload);
      relay.send({ t: 'send', to: 0, data });
    }).catch(() => undefined);
  }

  private enqueueReceive(data: string): void {
    this.receiveQueue = this.receiveQueue.then(() => this.receive(data)).catch(() => undefined);
  }

  private async receive(data: string): Promise<void> {
    const cipher = this.cipher;
    if (!cipher || !this.isActive) return;
    const r = await cipher.open('toGuest', data);
    // 読めない・古い・同じもの・ほかの人あての返事は捨てる (中継や第三者が混ぜたもの)
    if (!r.ok || r.payload.sid !== this.sid || !this.isActive) return;
    const p = r.payload;
    const link = this.link;
    switch (p.type) {
      case 'answer':
        if (this.hasAnswer || !link) return;
        this.hasAnswer = true;
        this.slotValue = p.slot;
        this.clearAnswerTimer();
        this.setPhase('connectingPeer');
        try {
          await link.acceptRelayAnswer(p.sdp, p.lobbyId, p.slot);
        } catch {
          this.lastDiagnostics = link.getDiagnostics();
          this.fail('connectionFailed');
        }
        break;
      case 'cand':
        if (this.hasAnswer && link) await link.addRemoteCandidate(p.c);
        break;
      case 'reject':
        if (p.reason === 'version') this.theirVersionValue = p.pv;
        this.fail(p.reason === 'full' ? 'full' : p.reason === 'version' ? 'version' : 'noRoom');
        break;
      default:
        break;
    }
  }

  private handleRelayEnd(end: RelayClientEnd): void {
    this.relay = null;
    if (!this.isActive) return;
    // answer を受け取ったあとなら、中継が切れても WebRTC の接続は続けられる (ホストがいなくなった場合を除く)
    if (this.hasAnswer && end !== 'hostLeft' && end !== 'kicked') return;
    switch (end) {
      case 'unreachable':
        this.fail('relayUnavailable');
        break;
      case 'noRoom':
      case 'expired':
      case 'hostLeft':
      case 'kicked':
        this.fail('noRoom');
        break;
      case 'full':
        this.fail('full');
        break;
      default:
        this.fail('relayError');
        break;
    }
  }

  private handleOpen(link: PeerLink): void {
    if (this.link !== link || !this.isActive) return;
    this.clearAnswerTimer();
    // つながったら中継はもう使わない (部屋の同時接続の枠を空け、課金も減らす)
    this.relay?.close();
    this.relay = null;
    this.setPhase('open');
    this.onOpen?.(new WebRtcClientTransport(link));
  }

  private fail(failure: GuestRoomFailure): void {
    if (!this.isActive) return;
    this.failureValue = failure;
    this.clearAnswerTimer();
    if (this.link) {
      this.lastDiagnostics = this.link.getDiagnostics();
      this.link.close();
      this.link = null;
    }
    this.relay?.close();
    this.relay = null;
    this.setPhase('failed');
    this.onFail?.(failure);
  }

  private clearAnswerTimer(): void {
    if (this.answerTimer !== null) clearTimeout(this.answerTimer);
    this.answerTimer = null;
  }

  private setPhase(phase: GuestRoomPhase): void {
    this.phaseValue = phase;
    this.onChange?.();
  }
}
