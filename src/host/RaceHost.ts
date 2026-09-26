import { netTimings } from '../net/netConfig';
import type { HostTransport, PeerLeaveReason } from '../net/Transport';
import { HostRaceJudge } from '../shared/net/HostRaceJudge';
import type { HostRaceEntry } from '../shared/net/HostRaceJudge';
import type {
  ClientMessage, CollisionMessage, JoinMessage, LobbyPlayer, LobbySettings, PlayerId, RejectReason, TyreChoice,
} from '../shared/net/messages';
import { isValidPlayerName } from '../shared/net/messages';
import type { NetClock } from '../shared/net/netClock';
import { gridToLightsOutOf, netRaceRules } from '../shared/net/netRaceRules';
import { maxPlayers, protocolVersion } from '../shared/net/protocol';
import { RateLimiter } from '../shared/net/RateLimiter';
import type { CarNetState, CarStateMessage, SnapshotMessage } from '../shared/net/stateCodec';
import { createCarStateMessage, createSnapshotMessage, decodeCarState, encodeSnapshot } from '../shared/net/stateCodec';
import { Random } from '../shared/Random';
import type { Track } from '../shared/Track';

export interface RaceHostOptions {
  transport: HostTransport;
  /** Worker では systemClock (ホスト時刻)。sim では仮想の時計 */
  clock: NetClock;
  /** コース (M4 はコース 1 だけ) */
  track: Track;
  /** 周回数の初期値 (既定 3) */
  laps?: number;
  /** レースごとの乱数の種を作る (既定は crypto.getRandomValues) */
  createSeed?: () => number;
}

export type RaceHostPhase = 'lobby' | 'race';

/** ok = 始めた、notReady = 準備完了でない人がいる、noPlayers = 誰もいない、inRace = レース中、closed = ロビーを閉じた */
export type StartRaceResult = 'ok' | 'notReady' | 'noPlayers' | 'inRace' | 'closed';

interface HostPlayer {
  id: PlayerId;
  name: string;
  team: number;
  isReady: boolean;
  tyre: TyreChoice;
}

/** つながっている相手 1 人ぶん (join 前を含む) */
interface HostPeer {
  stateLimit: RateLimiter;
  eventLimit: RateLimiter;
  isKicking: boolean;
  /** join を一度でも送ってきたか (DataChannel を開いたまま join しない相手は 5 秒で切断する) */
  hasSentJoin: boolean;
}

/** 周回数の範囲 (ホスト設定。game-design.md の 3 / 5 周を含む) */
const minLaps = 1;
const maxLaps = 9;

/**
 * ホストのロビーとレース進行 (network.md「全体構成」の Worker の中身、実装ステップ 3・6)。
 * HostTransport だけを通して参加者 (ホスト本人を含む) と話す。Worker にも DOM にも依存しないので、
 * sim では LoopbackNetwork の host に直接つなぐ。
 *
 * - ロビー: join (名前・チームの重複、名前の規則、バージョン違い、満員、レース中を拒否)、ready、参加者一覧 (lobby) の配信
 * - レース: raceStart (消灯の時刻とグリッド)、carState から判定 (HostRaceJudge)、スナップショット 30 回/秒、raceEvent、result
 * - 接触: collision を相手に中継する (2 台が近いときだけ)
 * - 不正対策: 受信頻度の上限 (state 60 回/秒、event 20 回/秒。超えた分を捨て、10 秒続いたら切断)、形の違う state の切断
 *
 * ```ts
 * const host = new RaceHost({ transport, clock: systemClock, track });
 * host.setLaps(5);
 * if (host.startRace() === 'ok') { ... }   // 全員が準備完了なら始まる
 * host.close();                            // 全員に hostClosed
 * ```
 */
export class RaceHost {
  phase: RaceHostPhase = 'lobby';
  /** 今のレースの判定 (レース中だけ) */
  judge: HostRaceJudge | null = null;
  /** ありえない移動を捨てたなどの警告 (ホストの開発用の表示・ログ) */
  onWarning: ((playerId: PlayerId, detail: string) => void) | null = null;
  /** 参加者一覧・フェーズが変わったとき */
  onChange: (() => void) | null = null;

  private readonly transport: HostTransport;
  private readonly clock: NetClock;
  private readonly track: Track;
  private readonly createSeed: () => number;
  private readonly players = new Map<PlayerId, HostPlayer>();
  private readonly peers = new Map<PlayerId, HostPeer>();
  private readonly raceIds: PlayerId[] = [];
  private readonly carMsg: CarStateMessage = createCarStateMessage();
  private readonly snapshot: SnapshotMessage = createSnapshotMessage();
  private readonly snapCars: CarNetState[] = this.snapshot.cars;
  private settingsValue: LobbySettings;
  private raceTimer: unknown = null;
  private nextTickAt = 0;
  private lobbyTimer: unknown = null;
  private isClosed = false;

  constructor(options: RaceHostOptions) {
    this.transport = options.transport;
    this.clock = options.clock;
    this.track = options.track;
    this.createSeed = options.createSeed ?? defaultSeed;
    this.settingsValue = { course: options.track.data.id, courseVersion: options.track.version, laps: clampLaps(options.laps ?? 3) };
    const t = this.transport;
    t.onPeerJoin = (id) => this.handlePeerJoin(id);
    t.onPeerLeave = (id, reason) => this.handlePeerLeave(id, reason);
    t.onEvent = (id, msg) => this.handleEvent(id, msg);
    t.onState = (id, data) => this.handleState(id, data);
    for (const id of t.peerIds) this.handlePeerJoin(id);
    this.scheduleLobbyRefresh();
  }

  get settings(): Readonly<LobbySettings> {
    return this.settingsValue;
  }

  /** ロビーの参加者一覧 (ID 順) */
  get lobbyPlayers(): LobbyPlayer[] {
    const list: LobbyPlayer[] = [];
    const ids = [...this.players.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      const p = this.players.get(id)!;
      const stats = this.transport.peerStats(id);
      list.push({
        id, name: p.name, team: p.team, isReady: p.isReady, tyre: p.tyre,
        route: id === 0 ? null : stats?.route ?? null,
        rttMs: id === 0 || stats?.rttMs == null ? null : Math.round(stats.rttMs),
      });
    }
    return list;
  }

  /** 全員が準備完了で、レースを始められるか */
  get canStart(): boolean {
    return this.phase === 'lobby' && this.players.size > 0 && [...this.players.values()].every((p) => p.isReady);
  }

  /** 周回数を変える (ロビーだけ)。全員に lobby を送り直す */
  setLaps(laps: number): void {
    if (this.phase !== 'lobby') return;
    this.settingsValue = { ...this.settingsValue, laps: clampLaps(laps) };
    this.broadcastLobby();
  }

  /** レースを始める。全員が準備完了のときだけ */
  startRace(): StartRaceResult {
    if (this.phase !== 'lobby') return 'inRace';
    if (this.players.size === 0) return 'noPlayers';
    if (!this.canStart) return 'notReady';
    const seed = this.createSeed() >>> 0;
    const now = this.clock.now();
    const startTime = now + netRaceRules.raceStartLeadMs + gridToLightsOutOf(seed) * 1000;
    // M4 は予選なし: グリッドは乱数で決める (全員に公平にするため)
    const ids = [...this.players.keys()].sort((a, b) => a - b);
    const random = new Random(seed ^ 0x5bd1e995);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(random.next() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const entries: HostRaceEntry[] = ids.map((id) => ({ playerId: id, carNumber: this.players.get(id)!.team }));
    this.judge = new HostRaceJudge({ track: this.track, totalLaps: this.settingsValue.laps, entries, startTime, seed, now });
    this.judge.onWarning = (id, detail) => this.onWarning?.(id, detail);
    this.raceIds.length = 0;
    this.raceIds.push(...ids);
    this.phase = 'race';
    for (const id of ids) {
      this.transport.sendEvent(id, { type: 'raceStart', session: 'race', startTime, settings: { ...this.settingsValue }, grid: ids.slice(), seed });
    }
    this.nextTickAt = now;
    this.tick();
    this.onChange?.();
    return 'ok';
  }

  /** 全員に hostClosed を送って閉じる */
  close(): void {
    if (this.isClosed) return;
    this.dispose();
    this.transport.close();
  }

  /** タイマーを止めて何も送らなくなる (hostClosed も送らない。sim でホストが落ちたときの確認用) */
  dispose(): void {
    this.isClosed = true;
    if (this.raceTimer !== null) this.clock.clearTimeout(this.raceTimer);
    if (this.lobbyTimer !== null) this.clock.clearTimeout(this.lobbyTimer);
    this.raceTimer = null;
    this.lobbyTimer = null;
    const t = this.transport;
    t.onPeerJoin = null;
    t.onPeerLeave = null;
    t.onEvent = null;
    t.onState = null;
  }

  // ------------------------------------------------------------------
  // 受信

  private handlePeerJoin(id: PlayerId): void {
    if (this.peers.has(id)) return;
    const peer: HostPeer = {
      stateLimit: new RateLimiter(netRaceRules.stateRateLimit),
      eventLimit: new RateLimiter(netRaceRules.eventRateLimit),
      isKicking: false,
      hasSentJoin: false,
    };
    this.peers.set(id, peer);
    // つながったのに join が来ない相手に枠を占有させない
    this.clock.setTimeout(() => {
      if (!this.isClosed && this.peers.get(id) === peer && !peer.hasSentJoin && !peer.isKicking) this.kick(id);
    }, netTimings.handshakeTimeoutMs);
  }

  private handlePeerLeave(id: PlayerId, _reason: PeerLeaveReason): void {
    this.peers.delete(id);
    const wasPlayer = this.players.delete(id);
    if (this.judge && this.phase === 'race') this.judge.disconnect(id, this.clock.now());
    if (wasPlayer) this.broadcastLobby();
  }

  private handleEvent(id: PlayerId, msg: ClientMessage): void {
    const peer = this.peers.get(id);
    if (!peer || peer.isKicking) return;
    const now = this.clock.now();
    if (!peer.eventLimit.allow(now)) {
      if (peer.eventLimit.isOverFor(now, netRaceRules.rateViolationKickMs)) this.kick(id);
      return;
    }
    switch (msg.type) {
      case 'join':
        peer.hasSentJoin = true;
        this.handleJoin(id, msg);
        break;
      case 'ready': {
        const p = this.players.get(id);
        if (!p || this.phase !== 'lobby') return;
        p.isReady = msg.isReady;
        p.tyre = msg.tyre;
        this.broadcastLobby();
        break;
      }
      case 'collision':
        this.relayCollision(id, msg, now);
        break;
    }
  }

  private handleJoin(id: PlayerId, msg: JoinMessage): void {
    if (msg.protocolVersion !== protocolVersion) {
      this.rejectAndKick(id, 'version');
      return;
    }
    const existing = this.players.get(id);
    if (this.phase === 'race') {
      if (!existing) this.rejectAndKick(id, 'raceInProgress');
      return;
    }
    let reason: RejectReason | null = null;
    if (!isValidPlayerName(msg.name)) reason = 'invalidName';
    else if (!existing && this.players.size >= maxPlayers) reason = 'full';
    else {
      for (const p of this.players.values()) {
        if (p.id === id) continue;
        if (p.name === msg.name) reason = 'nameTaken';
        else if (p.team === msg.team) reason ??= 'teamTaken';
      }
    }
    if (reason) {
      // 名前・チームの重複は、選び直して join を送り直せるように切断しない
      this.transport.sendEvent(id, { type: 'reject', reason });
      return;
    }
    this.players.set(id, { id, name: msg.name, team: msg.team, isReady: false, tyre: existing?.tyre ?? 'soft' });
    this.transport.sendEvent(id, { type: 'welcome', playerId: id, players: this.lobbyPlayers, settings: { ...this.settingsValue } });
    this.broadcastLobby(id);
  }

  private relayCollision(from: PlayerId, msg: CollisionMessage, now: number): void {
    const judge = this.judge;
    if (!judge || this.phase !== 'race') return;
    // 時刻が今からかけ離れたもの (古すぎる・未来) は中継しない
    if (msg.time < now - netRaceRules.collisionMaxAgeMs * 4 || msg.time > now + netRaceRules.maxStateLeadMs) return;
    // 衝撃が物理的にありえない大きさなら中継しない (受け取った側の車が NaN・暴走になるのを防ぐ)
    if (!(Math.hypot(msg.impulseX, msg.impulseY) <= netRaceRules.collisionImpulseMax)) return;
    if (!judge.canRelayCollision(from, msg.other)) return;
    // 速さの判定の緩和とフライングの免除は、押された側 (受け取る側) だけ。送った側が自分に付けられないように
    judge.noteCollision(msg.other, now);
    const relayed: CollisionMessage = { type: 'collision', other: from, impulseX: msg.impulseX, impulseY: msg.impulseY, time: msg.time };
    if (msg.spin) relayed.spin = msg.spin;
    this.transport.sendEvent(msg.other, relayed);
  }

  private handleState(id: PlayerId, data: ArrayBuffer): void {
    const peer = this.peers.get(id);
    if (!peer || peer.isKicking) return;
    const now = this.clock.now();
    if (!peer.stateLimit.allow(now)) {
      if (peer.stateLimit.isOverFor(now, netRaceRules.rateViolationKickMs)) this.kick(id);
      return;
    }
    // 参加者が送ってよい state は carState だけ (ping・pong は Transport が処理済み)
    if (!decodeCarState(data, this.carMsg)) {
      this.kick(id);
      return;
    }
    if (this.phase === 'race' && this.judge) {
      const rtt = this.transport.peerStats(id)?.rttMs;
      this.judge.applyState(id, this.carMsg, now, rtt == null ? 0 : rtt / 2);
    }
  }

  private kick(id: PlayerId): void {
    const peer = this.peers.get(id);
    if (peer) peer.isKicking = true;
    this.transport.kick(id, 'kicked');
  }

  private rejectAndKick(id: PlayerId, reason: RejectReason): void {
    const peer = this.peers.get(id);
    if (!peer || peer.isKicking) return;
    peer.isKicking = true;
    this.transport.sendEvent(id, { type: 'reject', reason });
    this.clock.setTimeout(() => {
      if (!this.isClosed && this.peers.get(id) === peer) this.transport.kick(id, 'kicked');
    }, netRaceRules.rejectKickDelayMs);
  }

  // ------------------------------------------------------------------
  // 送信

  /** 参加者一覧を全員に送る。skip の人には送らない (welcome を送ったばかりの人) */
  private broadcastLobby(skip: PlayerId | null = null): void {
    if (this.isClosed) return;
    const msg = { type: 'lobby' as const, players: this.lobbyPlayers, settings: { ...this.settingsValue } };
    for (const id of this.players.keys()) if (id !== skip) this.transport.sendEvent(id, msg);
    this.onChange?.();
  }

  /** ロビーでは往復遅延・接続経路を見せるため、一定間隔で送り直す */
  private scheduleLobbyRefresh(): void {
    this.lobbyTimer = this.clock.setTimeout(() => {
      this.lobbyTimer = null;
      if (this.isClosed) return;
      if (this.phase === 'lobby' && this.players.size > 0) this.broadcastLobby();
      this.scheduleLobbyRefresh();
    }, netRaceRules.lobbyRefreshMs);
  }

  /** レース中の 1 回 (30 回/秒): 判定を進め、イベントとスナップショットを送る */
  private tick(): void {
    this.raceTimer = null;
    const judge = this.judge;
    if (this.isClosed || !judge || this.phase !== 'race') return;
    const now = this.clock.now();
    for (const e of judge.update(now)) this.sendToRace(e);
    const count = judge.writeSnapshot(this.snapCars, now);
    const data = encodeSnapshot(now, this.snapCars, count);
    for (const id of this.raceIds) if (this.peers.has(id)) this.transport.sendState(id, data);
    if (judge.results) {
      this.sendToRace({ type: 'result', session: 'race', entries: judge.results });
      this.endRace();
      return;
    }
    // 遅れがたまらないよう、予定の時刻から次を決める (大きく遅れたら今から数え直す)
    this.nextTickAt += netRaceRules.snapshotIntervalMs;
    if (this.nextTickAt < now - netRaceRules.snapshotIntervalMs * 3) this.nextTickAt = now + netRaceRules.snapshotIntervalMs;
    this.raceTimer = this.clock.setTimeout(() => this.tick(), Math.max(0, this.nextTickAt - now));
  }

  private sendToRace(msg: Parameters<HostTransport['sendEvent']>[1]): void {
    for (const id of this.raceIds) if (this.peers.has(id)) this.transport.sendEvent(id, msg);
  }

  /** 結果を送ったらロビーに戻る (接続は切らない。全員の準備完了を戻す) */
  private endRace(): void {
    this.phase = 'lobby';
    this.raceIds.length = 0;
    for (const p of this.players.values()) p.isReady = false;
    this.broadcastLobby();
  }
}

function clampLaps(laps: number): number {
  return Math.max(minLaps, Math.min(maxLaps, Math.round(laps)));
}

function defaultSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}
