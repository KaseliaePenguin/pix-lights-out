import { LocalTransport } from '../net/LocalTransport';
import { NetClientSession } from '../net/NetClientSession';
import type { NetProfile } from '../net/NetClientSession';
import { netTimings } from '../net/netConfig';
import type { GatherReport, LinkDiagnostics } from '../net/PeerLink';
import { PeerLink } from '../net/PeerLink';
import type { CodeError } from '../shared/net/connectionCode';
import { checkConnectionCode, createLobbyId, decodeConnectionCode } from '../shared/net/connectionCode';
import type { LobbyPlayer, LobbySettings, PlayerId } from '../shared/net/messages';
import { maxSlot } from '../shared/net/protocol';
import type { Track } from '../shared/Track';
import type { RelayLinkEndReason, WorkerPort } from './HostRelay';
import { HostRelay } from './HostRelay';
import type { RaceHostPhase, StartRaceResult } from './RaceHost';
import type { FromWorkerMessage } from './workerProtocol';

/**
 * empty = 空き、preparing = 招待コードを作っている (候補の収集、最大 5 秒)、inviting = コード発行済み (返答待ち、10 分)、
 * connecting = 返答コードを受け付けて接続中 (最大 15 秒)、joined = 接続済み (名前・チームは session.players)、failed = 失敗
 */
export type HostSlotState = 'empty' | 'preparing' | 'inviting' | 'connecting' | 'joined' | 'failed';

/**
 * expired = 招待コードの期限切れ、gatherFailed = 招待コードを作れなかった、connectionFailed = ICE・DTLS の失敗・相手が閉じた、
 * timeout = 返答コードを貼ってから 15 秒で開かなかった
 */
export type HostSlotFailure = 'expired' | 'gatherFailed' | 'connectionFailed' | 'timeout';

/** 参加者の枠 1 つの表示用の値 */
export interface HostSlotView {
  /** 1〜7 */
  slot: number;
  state: HostSlotState;
  /** 招待コード (inviting のときだけ) */
  code: string | null;
  /** 招待コードの有効期限までの残り (ms、inviting のときだけ) */
  remainingMs: number | null;
  /** 候補の収集の結果 (STUN の応答なし・対称 NAT の疑いの警告に使う) */
  gather: GatherReport | null;
  failure: HostSlotFailure | null;
}

/**
 * 返答コードの受け付けの失敗。CodeError (malformed / wrongKind / version / unsupported) に加えて、
 * otherLobby = 別のロビーへの返答、notInvited = 招待を出していない枠、slotUsed = すでに接続中・参加済みの枠、
 * expired = 期限切れ、failed = その枠は失敗している (新しい招待コードを発行する)
 */
export type AcceptReplyError = CodeError | 'otherLobby' | 'notInvited' | 'slotUsed' | 'expired' | 'failed';

export type AcceptReplyResult = { ok: true; slot: number } | { ok: false; error: AcceptReplyError; slot: number | null };

/** Worker から届くロビー・レースの状態 */
export interface HostStatus {
  phase: RaceHostPhase;
  canStart: boolean;
  players: LobbyPlayer[];
  settings: LobbySettings;
}

interface SlotRecord {
  slot: number;
  state: HostSlotState;
  link: PeerLink | null;
  code: string | null;
  /** performance.now() の ms */
  expiresAt: number;
  gather: GatherReport | null;
  failure: HostSlotFailure | null;
  diagnostics: LinkDiagnostics | null;
  /** preparing 中に取り消された */
  isCancelled: boolean;
}

export interface HostLobbyOptions {
  /** 周回数の初期値 (既定 3) */
  laps?: number;
  /** Worker を差し替える (既定は src/host/hostWorker.ts) */
  createWorker?: () => WorkerPort & { terminate(): void };
}

/** close のあと Worker を止めるまで (hostClosed を送り終える時間) */
const terminateDelayMs = 1000;

/**
 * ホストのロビー (メインスレッド側、network.md「接続の手順」「全体構成」)。Worker (レース進行) を起動し、
 * HostRelay で参加者の DataChannel とつなぎ、ホスト本人のゲームを LocalTransport でつなぐ。
 * 招待コードの発行 (並行発行)・返答コードの受け付け (ロビー ID と枠で自動振り分け)・枠の管理 (期限 10 分) を受け持つ。
 * 期限切れは表示のたびに残り時間から判定する (タイマーを持たない)。
 *
 * ```ts
 * const lobby = HostLobby.create({ name: 'KASE', team: 1 }, getCourseTrack());
 * lobby.onChange = () => redraw();
 * const view = await lobby.issueInvite();          // view.code を [コピー]。null なら空き枠なし
 * const r = await lobby.acceptReply(pastedText);   // どの枠への返答かはコードから判別する
 * if (!r.ok) showError(r.error);                   // 'expired' / 'otherLobby' / 'malformed' など
 * lobby.session.setReady(true, 'soft');            // ホスト本人も参加者の 1 人
 * lobby.session.onRaceStart = (race) => game.changeScene(new NetRaceScene(game, lobby.session, race));
 * if (lobby.status?.canStart) await lobby.startRace();
 * lobby.close();                                   // 全員に hostClosed
 * ```
 */
export class HostLobby {
  readonly lobbyId: number;
  /** ホスト本人のプレイヤー (参加者と同じ扱い。枠 0) */
  readonly session: NetClientSession;
  /** Worker から届いた最新の状態 (最初の status が届くまで null) */
  status: HostStatus | null = null;
  /** 枠・status が変わったとき (参加者一覧は session.onChange でも分かる) */
  onChange: (() => void) | null = null;
  /** ホストの判定で捨てた不正な状態など (開発用) */
  onWarning: ((peerId: PlayerId, detail: string) => void) | null = null;

  private readonly worker: WorkerPort & { terminate(): void };
  private readonly relay: HostRelay;
  private readonly records: SlotRecord[] = [];
  private readonly startWaiters: ((r: StartRaceResult) => void)[] = [];
  private readonly onPageHide = () => this.relay.sendHostClosedNow();
  private isClosed = false;

  private constructor(profile: NetProfile, track: Track, options: HostLobbyOptions) {
    this.lobbyId = createLobbyId();
    this.worker = options.createWorker?.() ?? new Worker(new URL('./hostWorker.ts', import.meta.url), { type: 'module' });
    this.relay = new HostRelay(this.worker);
    this.relay.onLinkOpen = (peerId) => this.handleLinkOpen(peerId);
    this.relay.onLinkEnd = (peerId, reason) => this.handleLinkEnd(peerId, reason);
    this.relay.onWorkerMessage = (msg) => this.handleWorkerMessage(msg);
    for (let slot = 1; slot <= maxSlot; slot++) {
      this.records.push({ slot, state: 'empty', link: null, code: null, expiresAt: 0, gather: null, failure: null, diagnostics: null, isCancelled: false });
    }
    const channel = new MessageChannel();
    this.worker.postMessage({ kind: 'init', laps: options.laps ?? 3, localPort: channel.port2 }, [channel.port2]);
    this.session = new NetClientSession(new LocalTransport(channel.port1), profile, track);
    // タブを閉じる・再読み込みするときは、Worker を待たずに hostClosed を送る (届かないこともある)
    window.addEventListener('pagehide', this.onPageHide);
  }

  /** ロビーを作る (Worker を起動し、ホスト本人が join する) */
  static create(profile: NetProfile, track: Track, options: HostLobbyOptions = {}): HostLobby {
    return new HostLobby(profile, track, options);
  }

  /** 枠 1〜7 の表示用の値 (期限切れは残り時間から判定する) */
  get slots(): HostSlotView[] {
    const now = performance.now();
    return this.records.map((r) => this.viewOf(r, now));
  }

  slot(slot: number): HostSlotView | null {
    const r = this.records[slot - 1];
    return r ? this.viewOf(r, performance.now()) : null;
  }

  /** 参加者 (ホスト本人以外) とつながっているか。beforeunload の確認に使う */
  get hasGuests(): boolean {
    return this.relay.hasOpenLinks;
  }

  /**
   * 空いている枠に招待コードを作る (候補の収集に最大 5 秒)。押すたびに次の枠を使うので、並行して何人ぶんでも発行できる。
   * 空き枠がなければ null
   */
  async issueInvite(): Promise<HostSlotView | null> {
    if (this.isClosed) return null;
    this.expireStale();
    const r = this.records.find((x) => x.state === 'empty') ?? this.records.find((x) => x.state === 'failed');
    if (!r) return null;
    this.resetRecord(r);
    r.state = 'preparing';
    this.onChange?.();
    try {
      const offer = await PeerLink.createInvite(this.lobbyId, r.slot);
      if (r.isCancelled || this.isClosed) {
        offer.link.close();
        this.resetRecord(r);
        this.onChange?.();
        return this.viewOf(r, performance.now());
      }
      r.link = offer.link;
      r.code = offer.code;
      r.gather = offer.gather;
      r.expiresAt = performance.now() + netTimings.inviteLifetimeMs;
      r.state = 'inviting';
      this.relay.addLink(r.slot, offer.link);
    } catch {
      r.state = 'failed';
      r.failure = 'gatherFailed';
    }
    this.onChange?.();
    return this.viewOf(r, performance.now());
  }

  /** 返答コードを受け付けて接続を始める。どの枠への返答かはコードの中身 (ロビー ID・枠番号) で判別する */
  async acceptReply(text: string): Promise<AcceptReplyResult> {
    this.expireStale();
    const check = checkConnectionCode(text, 'reply');
    if (!check.ok) return { ok: false, error: check.error, slot: null };
    const { lobbyId, slot } = check.header;
    if (lobbyId !== this.lobbyId) return { ok: false, error: 'otherLobby', slot };
    const r = this.records[slot - 1];
    const refused = r ? this.refusalOf(r) : 'notInvited';
    if (refused) return { ok: false, error: refused, slot };
    const decoded = await decodeConnectionCode(text, 'reply');
    if (!decoded.ok) return { ok: false, error: decoded.error, slot };
    // コードを読んでいる間に状態が変わっていないか
    const again = this.refusalOf(r);
    if (again || !r.link) return { ok: false, error: again ?? 'failed', slot };
    r.state = 'connecting';
    this.onChange?.();
    try {
      await r.link.acceptReply(decoded.code);
    } catch {
      this.failRecord(r, 'connectionFailed');
      return { ok: false, error: 'failed', slot };
    }
    return { ok: true, slot };
  }

  /** 招待中・失敗の枠を空きに戻す (発行済みのコードは無効になる) */
  cancelInvite(slot: number): void {
    const r = this.records[slot - 1];
    if (!r || r.state === 'joined' || r.state === 'empty') return;
    if (r.state === 'preparing') {
      r.isCancelled = true;
      return;
    }
    this.relay.removeLink(r.slot);
    this.resetRecord(r);
    this.onChange?.();
  }

  /** [詳細をコピー] 用の記録 (IP アドレスを含まない)。失敗した枠は失敗した時点のもの */
  diagnosticsOf(slot: number): LinkDiagnostics | null {
    const r = this.records[slot - 1];
    if (!r) return null;
    return r.link ? r.link.getDiagnostics() : r.diagnostics;
  }

  /** 周回数を変える (ロビーだけ) */
  setLaps(laps: number): void {
    this.worker.postMessage({ kind: 'setLaps', laps });
  }

  /** レースを始める (全員が準備完了のときだけ始まる) */
  startRace(): Promise<StartRaceResult> {
    if (this.isClosed) return Promise.resolve('closed');
    return new Promise((resolve) => {
      this.startWaiters.push(resolve);
      this.worker.postMessage({ kind: 'startRace' });
    });
  }

  /** ロビーを閉じる。全員に hostClosed を送り、少し待って Worker を止める */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    window.removeEventListener('pagehide', this.onPageHide);
    this.relay.sendHostClosedNow();
    this.worker.postMessage({ kind: 'close' });
    for (const r of this.records) if (r.state === 'preparing') r.isCancelled = true;
    for (const resolve of this.startWaiters.splice(0)) resolve('closed');
    // Worker が closeAll を返さなくても、接続 (RTCPeerConnection) を残さない
    setTimeout(() => {
      this.relay.closeAllLinks();
      this.worker.terminate();
    }, terminateDelayMs);
  }

  // ------------------------------------------------------------------

  private viewOf(r: SlotRecord, now: number): HostSlotView {
    const isExpired = r.state === 'inviting' && now >= r.expiresAt;
    return {
      slot: r.slot,
      state: isExpired ? 'failed' : r.state,
      code: r.state === 'inviting' && !isExpired ? r.code : null,
      remainingMs: r.state === 'inviting' && !isExpired ? r.expiresAt - now : null,
      gather: r.gather,
      failure: isExpired ? 'expired' : r.failure,
    };
  }

  /** 返答コードを受け付けられない理由 (受け付けられるなら null) */
  private refusalOf(r: SlotRecord): AcceptReplyError | null {
    if (r.state === 'inviting' && performance.now() >= r.expiresAt) {
      this.failRecord(r, 'expired');
      return 'expired';
    }
    switch (r.state) {
      case 'inviting':
        return null;
      case 'connecting':
      case 'joined':
        return 'slotUsed';
      case 'failed':
        return r.failure === 'expired' ? 'expired' : 'failed';
      default:
        return 'notInvited';
    }
  }

  /** 期限切れの招待の接続を片付ける (受け付け・発行のときに呼ぶ) */
  private expireStale(): void {
    const now = performance.now();
    for (const r of this.records) if (r.state === 'inviting' && now >= r.expiresAt) this.failRecord(r, 'expired');
  }

  private failRecord(r: SlotRecord, failure: HostSlotFailure): void {
    r.diagnostics = r.link?.getDiagnostics() ?? r.diagnostics;
    if (r.link) this.relay.removeLink(r.slot);
    r.link = null;
    r.code = null;
    r.state = 'failed';
    r.failure = failure;
    this.onChange?.();
  }

  private resetRecord(r: SlotRecord): void {
    r.state = 'empty';
    r.link = null;
    r.code = null;
    r.expiresAt = 0;
    r.gather = null;
    r.failure = null;
    r.diagnostics = null;
    r.isCancelled = false;
  }

  private handleLinkOpen(peerId: PlayerId): void {
    const r = this.records[peerId - 1];
    if (!r) return;
    r.state = 'joined';
    r.code = null;
    this.onChange?.();
  }

  private handleLinkEnd(peerId: PlayerId, reason: RelayLinkEndReason): void {
    const r = this.records[peerId - 1];
    if (!r || !r.link) return;
    r.diagnostics = r.link.getDiagnostics();
    r.link = null;
    if (r.state === 'joined' || reason === 'kicked') {
      // 参加していた人が抜けたら、その枠は空きに戻る
      this.resetRecord(r);
    } else {
      r.state = 'failed';
      r.failure = reason === 'timeout' ? 'timeout' : 'connectionFailed';
      r.code = null;
    }
    this.onChange?.();
  }

  private handleWorkerMessage(msg: FromWorkerMessage): void {
    switch (msg.kind) {
      case 'status':
        this.status = { phase: msg.phase, canStart: msg.canStart, players: msg.players, settings: msg.settings };
        this.onChange?.();
        break;
      case 'startResult':
        this.startWaiters.shift()?.(msg.result);
        break;
      case 'warning':
        this.onWarning?.(msg.peerId, msg.detail);
        break;
      default:
        break;
    }
  }
}
