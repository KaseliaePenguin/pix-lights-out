import type { CarParams, RaceSessionRules } from '../shared/carParams';
import { carParams, raceRules, raceSessionRules } from '../shared/carParams';
import type { ContactOutcome, ContactResult } from '../shared/carContact';
import { createContactOutcome, detectContact, resolveContact } from '../shared/carContact';
import type { Controls } from '../shared/controls';
import { clearControls, copyControls } from '../shared/controls';
import type { LapEvent } from '../shared/LapTracker';
import { approach } from '../shared/math';
import type {
  CollisionMessage, HostMessage, LobbyPlayer, PlayerId, RaceEventMessage, RaceStartMessage, ResultEntry,
} from '../shared/net/messages';
import type { RaceStartSchedule } from '../shared/net/netRaceRules';
import { netRaceRules, raceStartSchedule } from '../shared/net/netRaceRules';
import type { RemotePose } from '../shared/net/RemoteCarTrack';
import { createRemotePose, RemoteCarTrack } from '../shared/net/RemoteCarTrack';
import type { CarNetState, SnapshotMessage } from '../shared/net/stateCodec';
import { createCarNetState, createSnapshotMessage, decodeSnapshot, encodeCarState } from '../shared/net/stateCodec';
import { RaceCar, gapLeader, gapNone, gapOut } from '../shared/RaceCar';
import type { RaceCarStepContext } from '../shared/raceCarSteps';
import { driveRaceCar } from '../shared/raceCarSteps';
import type { RaceGap } from '../shared/raceGap';
import type { RaceEvent, RaceResult, StandingsEntry } from '../shared/RaceSession';
import {
  isBlueFlagged, isLappedPair, provisionalPosition, raceDistanceOf, recordTiming, recordTimingByDistance, SessionBests,
  sortStandings, updateRaceGaps,
} from '../shared/raceStandings';
import { isInSlipstream } from '../shared/slipstream';
import type { Track, TrackProjection } from '../shared/Track';
import { createProjection } from '../shared/Track';
import type { ClientTransport, CloseReason } from './Transport';

/** グリッドの 1 台 */
export interface NetRaceEntry {
  playerId: PlayerId;
  /** 車番 = チーム (1〜8) */
  carNumber: number;
  name: string;
}

/** ホストとの接続が切れた理由。noSnapshot = 3 秒スナップショットが届かない */
export type NetAbortReason = CloseReason | 'noSnapshot';

/** grid〜racing は RaceSession と同じ。finished = 結果が届いた、aborted = ホストとの接続が切れた (結果は無効) */
export type NetRacePhase = 'grid' | 'racing' | 'finished' | 'aborted';

export type NetRaceEvent =
  | RaceEvent
  /** 状態が 3 秒届かずゴーストになった・戻った (自分なら「タブが裏に回っていた」の表示に使える) */
  | { type: 'carGhosted'; carNumber: number }
  | { type: 'carUnghosted'; carNumber: number }
  /** 参加者の接続が切れた (その車はリタイア。retired も続けて出る) */
  | { type: 'carDisconnected'; carNumber: number }
  /** ホストとの接続が切れた。レースを止めて「ホストとの接続が切れました」を出す */
  | { type: 'connectionLost'; reason: NetAbortReason };

export interface NetRaceStats {
  statesSent: number;
  snapshotsReceived: number;
  /** 自分で検出して衝撃を受けた接触 */
  contactsDetected: number;
  /** ホスト経由で届いた collision のうち、適用したもの・古すぎて捨てたもの・二重適用として捨てたもの */
  collisionsApplied: number;
  collisionsTooOld: number;
  collisionsDuplicate: number;
}

export interface NetRaceClientConfig {
  transport: ClientTransport;
  track: Track;
  /** 自分の ID (welcome の playerId) */
  playerId: PlayerId;
  start: RaceStartMessage;
  /** 名前とチーム (lobby の参加者一覧) */
  players: readonly LobbyPlayer[];
  params?: Readonly<CarParams>;
  rules?: Readonly<RaceSessionRules>;
}

/** ホストが知らせた他車の状態 (自分以外) */
interface RemoteState {
  readonly track: RemoteCarTrack;
  /** スナップショットのサンプルでの進行距離と時刻 (タイミングラインの記録用) */
  sampleDistance: number;
  sampleTime: number;
  hasSampleDistance: boolean;
  readonly sampleProjection: TrackProjection;
  /** 最後に衝撃を受けた・与えた時刻 (ホスト時刻 ms)。同じ組の 200ms 以内の二重適用を防ぐ */
  lastImpactAt: number;
  /** 接続が切れた (コースから取り除く) */
  isRemoved: boolean;
}

/**
 * マルチの決勝の参加者側 (ホスト本人も LocalTransport で同じものを使う。network.md「同期方式」、実装ステップ 5・7)。
 * - 自車の物理は自分で計算し、30 回/秒で carState を送る
 * - 他車はスナップショットを約 100ms 過去で補間して表示し、自車の近く (車 3 台分) では最新の状態と速度から予測する
 * - 接触は自車だけを動かし、collision をホスト経由で相手に伝える。受け取った collision は 250ms 以内なら適用する
 * - スタートは raceStart の時刻 (時刻合わせ済みのホスト時刻) に合わせる。周回・順位・ゴール・結果はホストの判定に従う
 * - ホストとの接続が切れたら (hostClosed・切断・3 秒スナップショットなし) phase を aborted にする
 *
 * RaceScene が RaceSession から読むものと同じ名前で状態を公開する (cars / player / order / orderNumbers / phase /
 * litLamps / raceTime / leaderLap / standings / isGhostPair / isResetAvailable / results)。DOM に依存しない。
 * 受信は NetClientSession が handleState / handleEvent / handleClose に渡す。
 *
 * ```ts
 * // シーンの update (固定 1/60 秒)
 * for (const e of race.step(controls, dt)) { ... }   // RaceSession と同じイベント + connectionLost など
 * // 描画: race.cars の rc.car (他車は表示用の位置が入っている)。race.isOnTrack(rc) が false の車は描かない
 * ```
 */
export class NetRaceClient {
  readonly track: Track;
  readonly totalLaps: number;
  readonly rules: Readonly<RaceSessionRules>;
  readonly playerId: PlayerId;
  readonly entries: readonly NetRaceEntry[];
  /** グリッド順 (cars[0] がポール)。carNumber はチーム */
  readonly cars: readonly RaceCar[];
  /** 自分の車 */
  readonly player: RaceCar;
  /** 今の順位の並び (先頭から) */
  readonly order: RaceCar[];
  readonly orderNumbers: number[];
  readonly schedule: RaceStartSchedule;
  readonly stats: NetRaceStats = {
    statesSent: 0, snapshotsReceived: 0, contactsDetected: 0, collisionsApplied: 0, collisionsTooOld: 0, collisionsDuplicate: 0,
  };

  phase: NetRacePhase = 'grid';
  /** セッションの経過時間 (秒、グリッドに並んだ時点が 0。raceStart が早く届けば負から始まる) */
  time: number;
  /** 消灯の時刻 (セッションの時刻) */
  readonly lightsOutAt: number;
  litLamps = 0;
  isCheckered = false;
  /** 確定した結果 (phase が finished になってから。ホストの result から作る) */
  results: readonly RaceResult[] = [];
  /** ホストの result そのもの */
  resultEntries: readonly ResultEntry[] | null = null;
  abortReason: NetAbortReason | null = null;
  /** 3 秒スナップショットが届かず、自分で接続を閉じたとき (NetClientSession が使う) */
  onAbort: ((reason: NetAbortReason) => void) | null = null;

  private readonly transport: ClientTransport;
  private readonly bests = new SessionBests();
  private readonly remotes: (RemoteState | null)[];
  private readonly indexOfPlayer = new Map<PlayerId, number>();
  private readonly events: NetRaceEvent[] = [];
  private readonly pendingEvents: NetRaceEvent[] = [];
  private readonly pendingCollisions: CollisionMessage[] = [];
  private readonly snapshot: SnapshotMessage = createSnapshotMessage();
  private readonly sendState: CarNetState;
  private readonly pose: RemotePose = createRemotePose();
  private readonly tmpContact: ContactResult = { depth: 0, nx: 0, ny: 0, x: 0, y: 0 };
  private readonly outcome: ContactOutcome = createContactOutcome();
  private readonly stepContext: RaceCarStepContext;
  private readonly finishedNow: RaceCar[] = [];
  private finishCount = 0;
  private sendAccumulator = 0;
  private lastSnapshotAt: number;
  /** ホストが自分の車をゴースト扱いにしている (状態が届いていなかった) */
  private isHostGhost = false;
  /** step の中か (受信処理の中で起きたイベントは次の step で返す) */
  private isInStep = false;
  private isFinalLapAnnounced = false;

  constructor(config: NetRaceClientConfig) {
    const track = config.track;
    const params = config.params ?? carParams;
    const start = config.start;
    this.transport = config.transport;
    this.track = track;
    this.totalLaps = start.settings.laps;
    this.rules = config.rules ?? raceSessionRules;
    this.playerId = config.playerId;
    this.schedule = raceStartSchedule(start.startTime, start.seed, this.rules);
    this.lightsOutAt = (start.startTime - this.schedule.gridAt) / 1000;

    const used = new Set<number>();
    this.entries = start.grid.map((id) => {
      const p = config.players.find((q) => q.id === id);
      let carNumber = p?.team ?? 1;
      // チームの重複はホストが拒否しているが、念のため車番がぶつからないようにする
      while (used.has(carNumber)) carNumber = (carNumber % 8) + 1;
      used.add(carNumber);
      return { playerId: id, carNumber, name: p?.name ?? '???' };
    });
    if (this.entries.length > track.gridSlots.length) throw new Error('too many cars for the grid');
    this.cars = this.entries.map((e, slot) => {
      const rc = new RaceCar(e.carNumber, e.playerId === config.playerId, slot, slot, track.gridSlots[slot], null, track, this.totalLaps, params);
      rc.car.placeAt(rc.gridPose);
      rc.lap.resetForStart(rc.car);
      rc.prevS = rc.lap.projection.s;
      rc.lapStartAt = this.lightsOutAt;
      rc.sectorStartAt = this.lightsOutAt;
      this.indexOfPlayer.set(e.playerId, slot);
      return rc;
    });
    const player = this.cars.find((rc) => rc.isPlayer);
    if (!player) throw new Error('player is not on the grid');
    this.player = player;
    this.remotes = this.cars.map((rc) => (rc.isPlayer ? null : {
      track: new RemoteCarTrack(), sampleDistance: 0, sampleTime: 0, hasSampleDistance: false,
      sampleProjection: createProjection(), lastImpactAt: -Infinity, isRemoved: false,
    }));
    this.sendState = createCarNetState(config.playerId);
    this.order = this.cars.slice();
    this.orderNumbers = this.cars.map((rc) => rc.carNumber);
    this.stepContext = {
      dt: 0, isStarted: false, tPrev: 0, lightsOutAt: this.lightsOutAt, events: this.events,
      isResetAvailable: (rc) => this.isResetAvailable(rc),
      overlapsAny: (rc) => this.overlapsAny(rc),
      handleLapEvent: (rc, e) => this.handleLapEvent(rc, e),
      tmpPose: { x: 0, y: 0, heading: 0 },
    };

    const now = this.transport.hostNow();
    this.lastSnapshotAt = now;
    this.time = (now - this.schedule.gridAt) / 1000;
    const r = this.rules;
    for (let k = 1; k <= r.lampCount; k++) if (this.time >= r.firstLampDelay + r.lampInterval * (k - 1) && this.time < this.lightsOutAt) this.litLamps = k;
    this.updateDistances();
    sortStandings(this.order, this.orderNumbers);
  }

  /** 消灯からの経過時間 (消灯前は 0) */
  get raceTime(): number {
    return Math.max(0, this.time - this.lightsOutAt);
  }

  /** 順位表の見出しの周 (先頭の車の周、1〜totalLaps) */
  get leaderLap(): number {
    const leader = this.order[0];
    return leader.isPlayer ? leader.displayLap(this.totalLaps) : Math.min(Math.max(leader.lapsCompleted + 1, 1), this.totalLaps);
  }

  /** 全体ベストラップとその車番 */
  get fastestLap(): number | null {
    return this.bests.fastestLap;
  }

  get fastestLapCarNumber(): number | null {
    return this.bests.fastestLapCarNumber;
  }

  /** 推定したホスト時刻 (ms) */
  hostNow(): number {
    return this.transport.hostNow();
  }

  carByNumber(carNumber: number): RaceCar | null {
    return this.cars.find((rc) => rc.carNumber === carNumber) ?? null;
  }

  carByPlayerId(playerId: PlayerId): RaceCar | null {
    const i = this.indexOfPlayer.get(playerId);
    return i === undefined ? null : this.cars[i];
  }

  /** 名前タグ・順位表に出す名前 */
  nameOf(carNumber: number): string {
    return this.entries.find((e) => e.carNumber === carNumber)?.name ?? '???';
  }

  playerIdOf(carNumber: number): PlayerId | null {
    return this.entries.find((e) => e.carNumber === carNumber)?.playerId ?? null;
  }

  /** コース上に描くか (リタイア・切断した他車は取り除く) */
  isOnTrack(rc: RaceCar): boolean {
    if (rc.isPlayer) return true;
    const r = this.remotes[rc.index];
    return !!r && !r.isRemoved && rc.status !== 'retired';
  }

  /** 順位表の行の元データ (先頭から)。out に詰めて返す */
  standings(out: StandingsEntry[]): StandingsEntry[] {
    for (let i = 0; i < this.order.length; i++) {
      const rc = this.order[i];
      if (i >= out.length) out.push({ carNumber: 0, isPlayer: false, gap: gapNone, hasFastestLap: false });
      const e = out[i];
      e.carNumber = rc.carNumber;
      e.isPlayer = rc.isPlayer;
      e.gap = rc.gapToAhead;
      e.hasFastestLap = rc.carNumber === this.bests.fastestLapCarNumber;
    }
    out.length = this.order.length;
    return out;
  }

  /** 自分の車がコース復帰を使えるか (PRESS R TO RESET) */
  isResetAvailable(rc: RaceCar): boolean {
    return (
      rc.isPlayer &&
      this.phase === 'racing' &&
      rc.status !== 'retired' &&
      rc.resetTimer < 0 &&
      rc.ghostTimeRemaining <= 0 &&
      // グリッドで止まっていた時間を「低速が続いた」と数えないよう、消灯から低速の判定時間が過ぎるまでは出さない
      this.time - this.lightsOutAt >= raceRules.resetSlowTime &&
      rc.lap.isResetAvailable(rc.car)
    );
  }

  /** 2 台がすり抜ける組み合わせか (cars の番号)。描画でゴーストに見せる判定にも使う */
  isGhostPair(a: number, b: number): boolean {
    const ca = this.cars[a];
    const cb = this.cars[b];
    if (this.isCarGhost(ca) || this.isCarGhost(cb)) return true;
    return isLappedPair(this.track, ca, cb, this.rules);
  }

  /** ホストと切断する (レースから抜ける)。ホストには切断として届き、自分の車はリタイアになる */
  leave(): void {
    this.transport.close();
    this.abort('connectionFailed', false);
  }

  // ------------------------------------------------------------------
  // 受信 (NetClientSession から)

  /** state チャンネルで届いたもの (スナップショット) */
  handleState(data: ArrayBuffer): void {
    if (this.phase === 'aborted' || !decodeSnapshot(data, this.snapshot)) return;
    const snap = this.snapshot;
    this.lastSnapshotAt = this.transport.hostNow();
    this.stats.snapshotsReceived++;
    const tSession = (snap.hostTime - this.schedule.gridAt) / 1000;
    for (let k = 0; k < snap.count; k++) {
      const s = snap.cars[k];
      const i = this.indexOfPlayer.get(s.id);
      if (i === undefined) continue;
      const remote = this.remotes[i];
      if (!remote) {
        this.isHostGhost = s.isGhost && this.player.status === 'racing';
        continue;
      }
      remote.track.push(snap.hostTime, s);
      const rc = this.cars[i];
      if (rc.status !== 'racing') continue;
      this.track.project(s.x, s.y, remote.sampleProjection.index, remote.sampleProjection);
      const d = raceDistanceOf(this.track, s.lap, s.checkpoint, remote.sampleProjection.s);
      if (remote.hasSampleDistance && tSession > remote.sampleTime) {
        recordTimingByDistance(rc, this.track, remote.sampleDistance, remote.sampleTime, d, tSession);
        this.recordDrsDetection(rc, remote.sampleDistance, remote.sampleTime, d, tSession);
      }
      remote.sampleDistance = d;
      remote.sampleTime = tSession;
      remote.hasSampleDistance = true;
    }
  }

  /** event チャンネルで届いたもの (raceEvent・result・collision) */
  handleEvent(msg: HostMessage): void {
    if (this.phase === 'aborted') return;
    switch (msg.type) {
      case 'raceEvent':
        this.applyRaceEvent(msg);
        break;
      case 'result':
        this.applyResult(msg.entries);
        break;
      case 'collision':
        if (this.pendingCollisions.length < 32) this.pendingCollisions.push(msg);
        break;
      default:
        break;
    }
  }

  /** ホストとの接続が切れた */
  handleClose(reason: CloseReason): void {
    this.abort(reason, true);
  }

  // ------------------------------------------------------------------
  // 1 フレーム

  /** 1 フレーム進める (固定 1/60 秒)。返す配列は次の step で使い回す */
  step(controls: Controls, dt: number): readonly NetRaceEvent[] {
    this.isInStep = true;
    try {
      return this.stepInner(controls, dt);
    } finally {
      this.isInStep = false;
    }
  }

  private stepInner(controls: Controls, dt: number): readonly NetRaceEvent[] {
    const events = this.events;
    events.length = 0;
    for (const e of this.pendingEvents) events.push(e);
    this.pendingEvents.length = 0;
    if (this.phase === 'aborted') return events;

    // 1. 時刻: 自分のシミュレーション時刻をホスト時刻に寄せる (タブが裏に回って止まっていたら合わせ直す)
    const hostNow = this.transport.hostNow();
    const tPrev = this.time;
    const target = (hostNow - this.schedule.gridAt) / 1000;
    this.time += dt;
    const err = target - this.time;
    this.time += Math.abs(err) * 1000 > netRaceRules.timeSnapMs ? err : err * netRaceRules.timeSlewRate;
    if (this.phase !== 'finished' && hostNow - this.lastSnapshotAt > netRaceRules.hostSilenceMs) {
      this.transport.close();
      this.abort('noSnapshot', true);
      this.onAbort?.('noSnapshot');
      for (const e of this.pendingEvents) events.push(e);
      this.pendingEvents.length = 0;
      return events;
    }
    this.updateStartLights(tPrev);
    const isStarted = this.phase !== 'grid';

    // 2. 届いた collision (相手が検出した接触) を自車に適用する
    this.applyCollisions(hostNow);

    // 3. 自車の入力・コース復帰・DRS・物理
    this.stepPlayer(controls, isStarted, tPrev, dt);

    // 4. 他車の表示位置 (近くは予測、遠くは約 100ms 過去の補間)
    this.updateRemotePoses(hostNow);

    // 5. 自車と他車の接触 (自車だけ動かし、相手には collision で伝える)
    this.detectContacts(hostNow);

    // 6. スリップストリーム (自車だけ)
    this.updateSlipstream(isStarted, dt);

    // 7. 自車の周回・タイミング
    const rc = this.player;
    this.finishedNow.length = 0;
    rc.lap.time = this.time - dt;
    for (const e of rc.lap.update(rc.car, dt)) this.handleLapEvent(rc, e);
    if (rc.resetTimer >= 0 || rc.ghostTimeRemaining > 0) rc.lap.holdResetConditions();
    this.detectDrsLine(rc, dt);
    if (isStarted && rc.status === 'racing') rc.currentLapTime = this.time - rc.lapStartAt;
    rc.ghostBlinkTime = rc.isGhostBlinking ? rc.ghostBlinkTime + dt : 0;

    // 8. 順位・差・BLUE FLAG
    this.updateDistances();
    if (this.phase !== 'finished') {
      sortStandings(this.order, this.orderNumbers);
      updateRaceGaps(this.order, this.track);
      const blue = this.phase === 'racing' && isBlueFlagged(rc, this.cars, this.track, this.rules);
      if (blue && !rc.isBlueFlag) events.push({ type: 'blueFlag', carNumber: rc.carNumber });
      rc.isBlueFlag = blue;
    }
    for (const f of this.finishedNow) {
      events.push({ type: 'carFinished', carNumber: f.carNumber, position: provisionalPosition(f, this.cars), time: f.finishTime ?? 0 });
    }

    // 9. 自車の状態を 30 回/秒で送る
    this.sendAccumulator += dt;
    if (this.sendAccumulator >= netRaceRules.stateIntervalMs / 1000 - 1e-9) {
      this.sendAccumulator = Math.min(this.sendAccumulator - netRaceRules.stateIntervalMs / 1000, netRaceRules.stateIntervalMs / 1000);
      if (this.time >= 0 && this.phase !== 'finished' && rc.status !== 'retired') this.sendCarState();
    }
    return events;
  }

  // ------------------------------------------------------------------
  // スタート (7.2 節)

  private updateStartLights(tPrev: number): void {
    if (this.phase !== 'grid') return;
    const r = this.rules;
    for (let k = 1; k <= r.lampCount; k++) {
      const at = r.firstLampDelay + r.lampInterval * (k - 1);
      if (tPrev < at && this.time >= at && this.time < this.lightsOutAt) {
        this.litLamps = k;
        this.events.push({ type: 'lampOn', count: k });
      }
    }
    if (this.time >= this.lightsOutAt) {
      this.phase = 'racing';
      this.litLamps = 0;
      this.events.push({ type: 'lightsOut' });
    }
  }

  // ------------------------------------------------------------------
  // 自車 (RaceSession のプレイヤーの車と同じ手順)

  private stepPlayer(controls: Controls, isStarted: boolean, tPrev: number, dt: number): void {
    const rc = this.player;
    if (rc.status === 'retired') clearControls(rc.controls);
    else copyControls(controls, rc.controls);
    const ctx = this.stepContext;
    ctx.dt = dt;
    ctx.isStarted = isStarted;
    ctx.tPrev = tPrev;
    driveRaceCar(rc, ctx);
  }

  /** ゴーストでない他車と重なっているか (ゴーストの延長の判定) */
  private overlapsAny(self: RaceCar): boolean {
    for (const rc of this.cars) {
      if (rc === self || this.isCarGhost(rc)) continue;
      if (isLappedPair(this.track, rc, self, this.rules)) continue;
      if (detectContact(self.car, rc.car, this.tmpContact)) return true;
    }
    return false;
  }

  /** 他車とすり抜ける状態か (自車は RaceCar.isGhost + ホストがゴースト扱い、他車はホストのフラグ) */
  private isCarGhost(rc: RaceCar): boolean {
    if (rc.isPlayer) return rc.isGhost || this.isHostGhost;
    const r = this.remotes[rc.index];
    return rc.status !== 'racing' || !r || r.isRemoved || r.track.isGhost || !r.track.hasSample;
  }

  // ------------------------------------------------------------------
  // 他車の表示と接触

  private updateRemotePoses(hostNow: number): void {
    const self = this.player.car;
    const renderAt = hostNow - netRaceRules.interpolationDelayMs;
    const pose = this.pose;
    for (let i = 0; i < this.cars.length; i++) {
      const remote = this.remotes[i];
      if (!remote || !remote.track.hasSample) continue;
      const rc = this.cars[i];
      const car = rc.car;
      // 近くの車は、最新の状態から今の位置を予測する (当たり判定がずれないように)
      remote.track.predict(hostNow, netRaceRules.predictMaxMs, pose);
      const isNear = Math.hypot(pose.x - self.x, pose.y - self.y) <= netRaceRules.predictRadius;
      if (!isNear) remote.track.interpolate(renderAt, netRaceRules.predictMaxMs, pose);
      car.prevX = car.x;
      car.prevY = car.y;
      car.x = pose.x;
      car.y = pose.y;
      car.heading = pose.heading;
      car.drawHeading = pose.heading;
      car.sF = pose.sF;
      car.sR = pose.sR;
      car.steer = pose.steer;
      car.drsOpen = remote.track.isDrsOpen;
      car.isReversing = remote.track.isReversing;
      rc.controls.brake = remote.track.isBraking ? 1 : 0;
      rc.controls.throttle = remote.track.isBraking ? 0 : 1;
      this.track.project(car.x, car.y, rc.lap.projection.index, rc.lap.projection);
      if (rc.status === 'racing') rc.distance = raceDistanceOf(this.track, pose.lap, pose.checkpoint, rc.lap.projection.s);
    }
  }

  private detectContacts(hostNow: number): void {
    const self = this.player;
    if (this.isCarGhost(self)) return;
    const cooldownMs = self.car.params.pairCooldown * 1000;
    for (let i = 0; i < this.cars.length; i++) {
      const remote = this.remotes[i];
      if (!remote) continue;
      const other = this.cars[i];
      if (this.isCarGhost(other) || isLappedPair(this.track, self, other, this.rules)) continue;
      if (!detectContact(self.car, other.car, this.tmpContact)) continue;
      const isCooledDown = hostNow - remote.lastImpactAt >= cooldownMs;
      const o = resolveContact(self.car, other.car, this.tmpContact, isCooledDown, false, this.outcome);
      self.car.pushOutOfWalls();
      if (o.impact <= 0) continue;
      remote.lastImpactAt = hostNow;
      this.stats.contactsDetected++;
      this.events.push({
        type: 'contact', carA: self.carNumber, carB: other.carNumber, impact: o.impact,
        x: this.tmpContact.x, y: this.tmpContact.y, spinA: o.spinA, spinB: o.spinB,
      });
      const msg: CollisionMessage = { type: 'collision', other: this.entries[i].playerId, impulseX: o.dvBx, impulseY: o.dvBy, time: hostNow };
      if (o.spinDirB !== 0) msg.spin = o.spinDirB;
      this.transport.sendEvent(msg);
    }
  }

  /** 相手が検出した接触を自車に適用する。接触から 250ms 以上たったもの、自分でも検出した組 (200ms 以内) は捨てる */
  private applyCollisions(hostNow: number): void {
    const list = this.pendingCollisions;
    if (list.length === 0) return;
    const self = this.player;
    const cooldownMs = self.car.params.pairCooldown * 1000;
    for (const msg of list) {
      const i = this.indexOfPlayer.get(msg.other);
      const remote = i === undefined ? null : this.remotes[i];
      if (!remote || i === undefined) continue;
      if (hostNow - msg.time > netRaceRules.collisionMaxAgeMs) {
        this.stats.collisionsTooOld++;
        continue;
      }
      if (Math.abs(msg.time - remote.lastImpactAt) < cooldownMs || hostNow - remote.lastImpactAt < cooldownMs) {
        this.stats.collisionsDuplicate++;
        continue;
      }
      if (this.isCarGhost(self) || self.status !== 'racing') continue;
      const car = self.car;
      // ホストも上限を超えるものは中継しないが、念のため物理的にありえる大きさに丸める
      const magnitude = Math.hypot(msg.impulseX, msg.impulseY);
      if (!Number.isFinite(magnitude)) continue;
      const scale = magnitude > netRaceRules.collisionImpulseMax ? netRaceRules.collisionImpulseMax / magnitude : 1;
      car.applyContactVelocity(car.vx + msg.impulseX * scale, car.vy + msg.impulseY * scale);
      if (msg.spin) car.startContactSpin(msg.spin);
      remote.lastImpactAt = msg.time;
      this.stats.collisionsApplied++;
      this.events.push({
        type: 'contact', carA: self.carNumber, carB: this.cars[i].carNumber, impact: Math.hypot(msg.impulseX, msg.impulseY),
        x: (car.x + this.cars[i].car.x) / 2, y: (car.y + this.cars[i].car.y) / 2, spinA: !!msg.spin, spinB: false,
      });
    }
    list.length = 0;
  }

  // ------------------------------------------------------------------
  // スリップストリーム・DRS (自車だけ)

  private updateSlipstream(isStarted: boolean, dt: number): void {
    const m = this.player;
    let isActive = false;
    if (isStarted && m.status !== 'retired') {
      for (const l of this.cars) {
        if (l === m || !this.isOnTrack(l) || this.isGhostPair(m.index, l.index)) continue;
        if (isInSlipstream(m.car, l.car)) {
          isActive = true;
          break;
        }
      }
    }
    m.car.fSlip = approach(m.car.fSlip, isActive ? 1 : 0, m.car.params.slipRate * dt);
  }

  /** 自車が DRS 検知ラインを通ったら、前の車が 1.000 秒以内に通っていれば、その周の区間で使える (7.6 節) */
  private detectDrsLine(rc: RaceCar, dt: number): void {
    const s = rc.lap.projection.s;
    const det = this.track.drsDetectionS;
    const moved = this.track.deltaS(rc.prevS, s);
    const before = this.track.deltaS(rc.prevS, det);
    rc.prevS = s;
    if (!(moved > 0 && moved < 60 && before > 0 && before <= moved)) return;
    const at = this.time - dt + (before / moved) * dt;
    let isEligible = false;
    if (this.phase === 'racing' && rc.status === 'racing' && rc.lap.lap >= this.rules.drsMinLap) {
      for (const o of this.cars) {
        if (o === rc || o.status === 'retired' || o.lap.isInPitLane) continue;
        const t = o.lastDrsDetectionAt;
        if (t <= at && at - t <= this.rules.drsGapThreshold) {
          isEligible = true;
          break;
        }
      }
    }
    rc.lastDrsDetectionAt = at;
    rc.isDrsEligible = isEligible;
    if (isEligible) this.events.push({ type: 'drsAvailable', carNumber: rc.carNumber });
  }

  /** 他車が DRS 検知ラインを通った時刻を、スナップショットの進行距離から求める */
  private recordDrsDetection(rc: RaceCar, d0: number, t0: number, d1: number, t1: number): void {
    if (!(d1 > d0) || d1 - d0 > this.track.length / 4) return;
    const L = this.track.length;
    const det = this.track.drsDetectionS;
    const v = det + Math.floor((d1 - det) / L) * L;
    if (v > d0) rc.lastDrsDetectionAt = t0 + ((v - d0) / (d1 - d0)) * (t1 - t0);
  }

  // ------------------------------------------------------------------
  // 周回 (自車は自分の LapTracker、他車はホストの raceEvent)

  private handleLapEvent(rc: RaceCar, e: LapEvent): void {
    this.events.push({ type: 'lap', carNumber: rc.carNumber, event: e });
    if (this.phase === 'finished' || rc.status !== 'racing') return;
    const lines = this.track.timingLines.length;
    switch (e.type) {
      case 'lapStarted':
        if (e.lap >= 2) {
          rc.lapStartAt = e.time;
          rc.sectorStartAt = e.time;
        }
        rc.sectorResults.fill('none');
        recordTiming(rc, e.lap * lines, e.time);
        if (e.lap === this.totalLaps) this.announceFinalLap();
        break;
      case 'timingLine':
        recordTiming(rc, e.lap * lines + e.index, e.at);
        break;
      case 'sector': {
        const time = e.at - rc.sectorStartAt;
        rc.sectorStartAt = e.at;
        const result = this.bests.classifySector(rc, e.index, time, e.valid);
        rc.sectorResults[e.index] = result;
        this.events.push({ type: 'sectorResult', carNumber: rc.carNumber, lap: e.lap, index: e.index, time, result });
        break;
      }
      case 'lapCompleted': {
        const time = e.at - rc.lapStartAt;
        this.completeLap(rc, e.lap, time, e.valid, this.events);
        this.events.push({ type: 'lapResult', carNumber: rc.carNumber, lap: e.lap, time, result: rc.lastLapResult });
        // 最終周を終えた、またはチェッカーが出ていればゴール (確定はホストの finish で上書きする)
        if (this.isCheckered || e.lap >= this.totalLaps) this.finishCar(rc, e.lap, e.at - this.lightsOutAt, this.events);
        break;
      }
      case 'pitExit':
        rc.pitGhostRemaining = this.rules.pitExitGhostTime;
        break;
      default:
        break;
    }
  }

  private completeLap(rc: RaceCar, lap: number, time: number, valid: boolean, out: NetRaceEvent[]): void {
    if (lap <= rc.lapsCompleted) return;
    rc.lapsCompleted = lap;
    rc.lastLap = time;
    rc.lapTimes.push(time);
    const result = this.bests.classifyLap(rc, time, valid);
    rc.lastLapResult = result;
    if (result === 'overall' && lap >= 2) out.push({ type: 'fastestLap', carNumber: rc.carNumber, lap, time });
  }

  private announceFinalLap(): void {
    if (this.isFinalLapAnnounced || this.isCheckered) return;
    this.isFinalLapAnnounced = true;
    this.pendingOrNow().push({ type: 'finalLap' });
  }

  private finishCar(rc: RaceCar, lap: number, finishTime: number, out: NetRaceEvent[]): void {
    if (!this.isCheckered) {
      this.isCheckered = true;
      out.push({ type: 'checkeredFlag', carNumber: rc.carNumber });
    }
    if (rc.status !== 'racing') {
      // 自分で先にゴールにしていたら、ホストの値 (確定) で上書きするだけ
      if (rc.status === 'finished') rc.finishTime = finishTime;
      return;
    }
    rc.status = 'finished';
    rc.finishTime = finishTime;
    rc.finishOrder = this.finishCount++;
    rc.lapsCompleted = Math.max(rc.lapsCompleted, lap);
    rc.distance = lap * this.track.length;
    rc.car.closeDrs();
    if (out === this.events) this.finishedNow.push(rc);
    else out.push({ type: 'carFinished', carNumber: rc.carNumber, position: provisionalPosition(rc, this.cars), time: finishTime });
  }

  /** step の中なら今のフレームの配列、受信処理の中なら次の step で返す配列 */
  private pendingOrNow(): NetRaceEvent[] {
    return this.isInStep ? this.events : this.pendingEvents;
  }

  private applyRaceEvent(msg: RaceEventMessage): void {
    const i = this.indexOfPlayer.get(msg.playerId);
    if (i === undefined) return;
    const rc = this.cars[i];
    const out = this.pendingEvents;
    const L = this.track.length;
    switch (msg.event) {
      case 'lap':
        if (msg.lap === undefined || msg.value === undefined) return;
        // 自分の周回は自分の LapTracker で判定済み (ラップタイムの表示を待たせないため)
        if (!rc.isPlayer) this.completeLap(rc, msg.lap, msg.value, true, out);
        if (msg.lap === this.totalLaps - 1) this.announceFinalLap();
        break;
      case 'finish':
        if (msg.lap === undefined || msg.value === undefined) return;
        this.finishCar(rc, msg.lap, msg.value, out);
        if (rc.status === 'finished') rc.distance = rc.lapsCompleted * L;
        break;
      case 'penalty':
        rc.penalty += msg.value ?? 0;
        if (!rc.isJumpStart) {
          rc.isJumpStart = true;
          out.push({ type: 'jumpStart', carNumber: rc.carNumber });
        }
        break;
      case 'ghost':
        out.push({ type: 'carGhosted', carNumber: rc.carNumber });
        break;
      case 'unghost':
        if (rc.isPlayer) this.isHostGhost = false;
        out.push({ type: 'carUnghosted', carNumber: rc.carNumber });
        break;
      case 'disconnected':
        if (this.remotes[i]) this.remotes[i]!.isRemoved = true;
        out.push({ type: 'carDisconnected', carNumber: rc.carNumber });
        this.retireCar(rc, out);
        break;
      case 'retired':
      case 'disqualified':
        this.retireCar(rc, out);
        break;
    }
  }

  private retireCar(rc: RaceCar, out: NetRaceEvent[]): void {
    if (rc.status === 'retired' || rc.status === 'finished' || rc.status === 'unclassified') return;
    rc.status = 'retired';
    rc.car.closeDrs();
    if (rc.isPlayer) rc.car.controlLocked = true;
    out.push({ type: 'retired', carNumber: rc.carNumber });
  }

  private applyResult(entries: readonly ResultEntry[]): void {
    if (this.phase === 'finished') return;
    this.resultEntries = entries.slice();
    const L = this.track.length;
    const rows: RaceResult[] = [];
    let winner: ResultEntry | null = null;
    for (const e of entries) if (e.status === 'finished' && (winner === null || e.position < winner.position)) winner = e;
    for (const e of [...entries].sort((a, b) => a.position - b.position)) {
      const rc = this.carByPlayerId(e.playerId);
      if (!rc) continue;
      rc.status = e.status === 'disqualified' ? 'retired' : e.status;
      rc.lapsCompleted = e.lapsCompleted;
      rc.penalty = e.penalty;
      rc.bestLap = e.bestLap;
      rc.finishTime = e.totalTime === null ? null : e.totalTime - e.penalty;
      let gap: RaceGap = gapNone;
      if (rc.status === 'retired') gap = gapOut;
      else if (e === winner) gap = gapLeader;
      else if (winner) {
        const laps = e.status === 'finished'
          ? winner.lapsCompleted - e.lapsCompleted
          : Math.max(1, Math.ceil((winner.lapsCompleted * L - rc.distance) / L));
        gap = laps > 0 ? { kind: 'laps', laps } : { kind: 'time', seconds: (e.totalTime ?? 0) - (winner.totalTime ?? 0) };
      }
      rows.push({
        carNumber: rc.carNumber,
        isPlayer: rc.isPlayer,
        position: e.position,
        status: rc.status === 'finished' ? 'finished' : rc.status === 'retired' ? 'retired' : 'unclassified',
        lapsCompleted: e.lapsCompleted,
        finishTime: rc.finishTime,
        penalty: e.penalty,
        totalTime: e.totalTime,
        gapToWinner: gap,
        bestLap: e.bestLap,
        isJumpStart: rc.isJumpStart,
        isEstimated: false,
      });
    }
    this.results = rows;
    this.phase = 'finished';
    // 確定順に並べ直す
    const byPosition = new Map(rows.map((r) => [r.carNumber, r.position]));
    this.order.sort((a, b) => (byPosition.get(a.carNumber) ?? 99) - (byPosition.get(b.carNumber) ?? 99));
    for (let k = 0; k < this.order.length; k++) {
      this.order[k].position = k + 1;
      this.orderNumbers[k] = this.order[k].carNumber;
    }
    this.pendingEvents.push({ type: 'raceFinished' });
  }

  private abort(reason: NetAbortReason, notify: boolean): void {
    if (this.phase === 'aborted') return;
    this.abortReason = reason;
    // 結果が届いたあとの切断は、レースの結果には影響しない
    if (this.phase === 'finished') return;
    this.phase = 'aborted';
    this.player.car.controlLocked = true;
    if (notify) this.pendingEvents.push({ type: 'connectionLost', reason });
  }

  // ------------------------------------------------------------------

  private updateDistances(): void {
    const rc = this.player;
    if (rc.status === 'racing') rc.distance = raceDistanceOf(this.track, rc.lap.lap, rc.lap.nextCheckpoint, rc.lap.projection.s);
  }

  private sendCarState(): void {
    const rc = this.player;
    const car = rc.car;
    const s = this.sendState;
    s.x = car.x;
    s.y = car.y;
    s.heading = car.heading;
    // スピン中も相手が速度を復元できるよう、車体の向きに対する速度にして送る
    const vx = car.vx;
    const vy = car.vy;
    const sin = Math.sin(car.heading);
    const cos = Math.cos(car.heading);
    s.sF = vx * sin - vy * cos;
    s.sR = vx * cos + vy * sin;
    s.steer = car.steer;
    s.lap = rc.lap.lap;
    s.checkpoint = rc.lap.nextCheckpoint;
    s.isDrsOpen = car.drsOpen;
    s.isBraking = rc.controls.brake > 0;
    s.isReversing = car.isReversing;
    s.isGhost = rc.isGhost;
    s.isInPit = rc.lap.isInPitLane;
    s.isSpinning = car.isSpinning;
    s.isResetting = rc.resetTimer >= 0;
    this.transport.sendState(encodeCarState(this.schedule.gridAt + this.time * 1000, s));
    this.stats.statesSent++;
  }
}
