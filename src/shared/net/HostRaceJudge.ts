import type { CarParams, RaceSessionRules } from '../carParams';
import { carParams, raceSessionRules } from '../carParams';
import type { ContactResult } from '../carContact';
import { detectContact } from '../carContact';
import type { LapEvent } from '../LapTracker';
import { wrapAngle } from '../math';
import { RaceCar } from '../RaceCar';
import { buildRaceResults, raceDistanceOf, recordTiming, SessionBests } from '../raceStandings';
import type { Pose, Track, TrackProjection } from '../Track';
import { createProjection, SurfaceCode } from '../Track';
import type { PlayerId, RaceEventKind, RaceEventMessage, ResultEntry } from './messages';
import type { RaceStartSchedule } from './netRaceRules';
import { netRaceRules, raceStartSchedule } from './netRaceRules';
import type { CarNetState, CarStateMessage } from './stateCodec';
import { createCarNetState } from './stateCodec';

/** グリッドの 1 台 (grid の順に並べる。先頭がポール) */
export interface HostRaceEntry {
  playerId: PlayerId;
  /** 車番 = チーム (1〜8) */
  carNumber: number;
}

export interface HostRaceConfig {
  track: Track;
  totalLaps: number;
  entries: readonly HostRaceEntry[];
  /** 消灯の時刻 (ホスト時刻 ms) と乱数の種 (raceStart と同じ値) */
  startTime: number;
  seed: number;
  /** raceStart を送った時刻 (ホスト時刻 ms)。状態が届かない時間はここから数え始める */
  now: number;
  params?: Readonly<CarParams>;
  rules?: Readonly<RaceSessionRules>;
}

/** ignored = ありえない移動として捨てた */
export type StateVerdict = 'accepted' | 'reset' | 'ignored' | 'dropped';

export type HostRacePhase = 'grid' | 'racing' | 'finished';

/** ホストだけが持つ、車 1 台ぶんの受信の記録 */
interface HostCarRecord {
  readonly playerId: PlayerId;
  /** 最後に受け付けた状態 (フラグをスナップショットに載せる) */
  readonly last: CarNetState;
  /** 最後に受け付けた状態の時刻 (送った側のホスト時刻 ms) */
  lastTime: number;
  /** 最後に状態が届いた時刻 (ホスト時刻 ms)。捨てたものも数える (60 秒のリタイアの判定だけに使う) */
  lastHeardAt: number;
  /** 最後に状態を受け付けた時刻 (到着したホスト時刻 ms)。3 秒のゴーストの判定に使う */
  lastAcceptedAt: number;
  /** 移動量の余裕 (px)。使った分は時間で戻る (1 通ごとの固定の余裕を積み重ねて速く走る不正を防ぐ) */
  slackPx: number;
  /** 最後にコース復帰の置き直しを受け付けた状態の時刻 (ms) */
  lastResetAt: number;
  /** 参加者が isGhost を申告し続けている始まりの時刻 (ピットレーン外。申告していなければ null) */
  reportedGhostSince: number | null;
  /** 申告の isGhost を認めているか (スナップショットに載せる) */
  isReportedGhostAllowed: boolean;
  hasState: boolean;
  /** 状態が 3 秒届かずゴーストにしている */
  isStale: boolean;
  lastCollisionAt: number;
  /** ありえない移動を捨てた回数 */
  warnings: number;
  /** 消灯後にフライングを判定済み */
  isStartJudged: boolean;
}

/**
 * マルチの決勝のホスト側の判定 (network.md「同期方式」「ホストによる判定と不正対策」、game-design.md 7 章)。
 * 各参加者の carState から、周回・チェックポイント・順位・フライング・ゴール・結果を判定する。
 * 車の物理は計算しない (各参加者が自分の車を計算する)。周回の判定は 1 人用と同じ LapTracker を、
 * 届いた位置で動かして行う。時刻はすべてホスト時刻 (ms)。DOM にも Transport にも依存しない (sim から直接使う)。
 *
 * ```ts
 * const judge = new HostRaceJudge({ track, totalLaps: 3, entries, startTime, seed, now });
 * judge.applyState(peerId, carStateMessage, now);           // carState が届くたびに
 * for (const e of judge.update(now)) transport.broadcastEvent(e);   // 30 回/秒
 * const count = judge.writeSnapshot(cars, now);            // スナップショット
 * if (judge.results) transport.broadcastEvent({ type: 'result', session: 'race', entries: judge.results });
 * ```
 */
export class HostRaceJudge {
  readonly track: Track;
  readonly totalLaps: number;
  readonly rules: Readonly<RaceSessionRules>;
  readonly schedule: RaceStartSchedule;
  /** グリッド順 (cars[0] がポール)。carNumber はチーム */
  readonly cars: readonly RaceCar[];
  phase: HostRacePhase = 'grid';
  isCheckered = false;
  /** 確定した結果 (phase が finished になってから) */
  results: ResultEntry[] | null = null;
  /** ありえない移動を捨てたときに呼ばれる (ホストの画面・ログ用) */
  onWarning: ((playerId: PlayerId, detail: string) => void) | null = null;

  private readonly records: HostCarRecord[];
  private readonly indexOf = new Map<PlayerId, number>();
  private readonly bests = new SessionBests();
  private readonly events: RaceEventMessage[] = [];
  /** applyState などで起きて、次の update で返すイベント */
  private readonly pending: RaceEventMessage[] = [];
  private readonly lightsOutAt: number;
  private readonly maxSpeed: number;
  private readonly launchAccel: number;
  private readonly tmpPose: Pose = { x: 0, y: 0, heading: 0 };
  private readonly tmpContact: ContactResult = { depth: 0, nx: 0, ny: 0, x: 0, y: 0 };
  private readonly tmpProjection: TrackProjection = createProjection();
  private readonly tmpPoint = { x: 0, y: 0 };
  private readonly params: Readonly<CarParams>;
  /** collision を中継する 2 台の中心の距離の上限 (px) */
  private readonly relayDistance: number;
  private leaderFinishAt = 0;
  private finishCount = 0;

  constructor(config: HostRaceConfig) {
    const track = config.track;
    const params = config.params ?? carParams;
    this.track = track;
    this.totalLaps = config.totalLaps;
    this.rules = config.rules ?? raceSessionRules;
    this.schedule = raceStartSchedule(config.startTime, config.seed, this.rules);
    this.lightsOutAt = this.toSession(config.startTime);
    this.maxSpeed = params.vBase * (1 + params.bonusCap) * netRaceRules.speedLimitFactor;
    this.launchAccel = params.accel0 * 1.5;
    this.params = params;
    // 当たり判定の外接円の直径 × 係数 (最後に届いた位置の遅れの分の余裕を含める)
    this.relayDistance = 2 * Math.hypot(params.hitWidth / 2, params.hitLength / 2) * netRaceRules.collisionRelayReachFactor;
    if (config.entries.length > track.gridSlots.length) throw new Error('too many cars for the grid');
    this.cars = config.entries.map((e, slot) => {
      const rc = new RaceCar(e.carNumber, false, slot, slot, track.gridSlots[slot], null, track, this.totalLaps, params);
      rc.car.placeAt(rc.gridPose);
      rc.lap.resetForStart(rc.car);
      rc.prevS = rc.lap.projection.s;
      rc.lapStartAt = this.lightsOutAt;
      rc.sectorStartAt = this.lightsOutAt;
      return rc;
    });
    this.records = config.entries.map((e, i) => {
      this.indexOf.set(e.playerId, i);
      const last = createCarNetState(e.playerId);
      const pose = track.gridSlots[i];
      last.x = pose.x;
      last.y = pose.y;
      last.heading = pose.heading;
      return {
        playerId: e.playerId, last, lastTime: this.schedule.gridAt, lastHeardAt: config.now, lastAcceptedAt: config.now,
        slackPx: netRaceRules.moveSlackPx, lastResetAt: -Infinity, reportedGhostSince: null, isReportedGhostAllowed: false,
        hasState: false, isStale: false, lastCollisionAt: -Infinity, warnings: 0, isStartJudged: false,
      };
    });
    this.updateDistances();
  }

  /** プレイヤーの車 (いなければ null) */
  carOf(playerId: PlayerId): RaceCar | null {
    const i = this.indexOf.get(playerId);
    return i === undefined ? null : this.cars[i];
  }

  /** ありえない移動を捨てた回数 */
  warningsOf(playerId: PlayerId): number {
    const i = this.indexOf.get(playerId);
    return i === undefined ? 0 : this.records[i].warnings;
  }

  /** 状態が届かずゴーストにしているか */
  isStale(playerId: PlayerId): boolean {
    const i = this.indexOf.get(playerId);
    return i !== undefined && this.records[i].isStale;
  }

  /**
   * 参加者の carState を反映する。判定に使う時刻は「到着した時刻 − 片道の遅延の推定 (oneWayMs)」を基準にし、
   * 申告の時刻 (msg.time) がそこから外れていれば丸める (時刻をずらしてタイムを縮める不正を防ぐ)。
   * 次のものは捨てて 'ignored' を返す: 速度の上限超え、壁の中・壁を横切る移動、前回からの時間で走れる距離を超える移動
   * (瞬間移動)。コース復帰の置き直しは、間隔と位置 (最後に正常に走っていた地点より後ろ) が正しいときだけ受け付ける
   */
  applyState(playerId: PlayerId, msg: CarStateMessage, now: number, oneWayMs = 0): StateVerdict {
    const i = this.indexOf.get(playerId);
    if (i === undefined) return 'dropped';
    const rc = this.cars[i];
    const rec = this.records[i];
    if (rc.status === 'retired' || this.phase === 'finished') return 'dropped';
    rec.lastHeardAt = now;
    const ref = now - Math.max(0, oneWayMs);
    const tol = netRaceRules.stateTimeToleranceMs;
    const t = Math.max(ref - tol, Math.min(ref + tol, msg.time));
    if (t <= rec.lastTime) return 'dropped';
    const s = msg.car;
    const car = rc.car;
    const dt = (t - rec.lastTime) / 1000;
    const isLenient = now - rec.lastCollisionAt < netRaceRules.collisionLeniencyMs;
    const speedLimit = this.maxSpeed * (isLenient ? netRaceRules.collisionLeniencyFactor : 1);
    const speed = Math.hypot(s.sF, s.sR);
    if (!(speed <= speedLimit)) return this.ignore(rec, `speed ${speed.toFixed(0)} px/s`);
    if (this.track.surfaceCodeAt(s.x, s.y) === SurfaceCode.wall) return this.ignore(rec, 'inside a wall');
    rec.slackPx = Math.min(netRaceRules.moveSlackPx, rec.slackPx + netRaceRules.moveSlackRefillPxPerSec * dt);
    const moved = Math.hypot(s.x - car.x, s.y - car.y);
    const excess = moved - speedLimit * dt;
    let verdict: StateVerdict = 'accepted';
    if (excess > rec.slackPx) {
      if (!this.isValidReset(rc, rec, s, t)) return this.ignore(rec, `moved ${moved.toFixed(0)} px in ${(dt * 1000).toFixed(0)} ms`);
      verdict = 'reset';
      rec.lastResetAt = t;
    } else {
      if (this.crossesWall(car.x, car.y, s.x, s.y)) return this.ignore(rec, 'crossed a wall');
      rec.slackPx -= Math.max(0, excess);
    }
    copyNetState(s, rec.last, playerId);
    rec.last.heading = wrapAngle(s.heading);
    rec.lastTime = t;
    rec.lastAcceptedAt = now;
    rec.hasState = true;

    if (verdict === 'reset') {
      this.tmpPose.x = s.x;
      this.tmpPose.y = s.y;
      this.tmpPose.heading = rec.last.heading;
      car.placeAt(this.tmpPose);
      rc.lap.time = this.toSession(t);
      for (const e of rc.lap.applyReset(car)) this.handleLapEvent(rc, e);
    } else {
      car.prevX = car.x;
      car.prevY = car.y;
      car.x = s.x;
      car.y = s.y;
      car.heading = rec.last.heading;
      car.sF = s.sF;
      car.sR = s.sR;
      car.steer = s.steer;
      car.wheelsOffTrack = this.countWheelsOffTrack(car);
      rc.lap.time = this.toSession(t) - dt;
      for (const e of rc.lap.update(car, dt)) this.handleLapEvent(rc, e);
    }
    this.judgeReportedGhost(rc, rec, s.isGhost, t);
    this.judgeJumpStart(rc, rec, t);
    return verdict;
  }

  /** collision を受け付けた (この後しばらく速さの判定を緩める) */
  noteCollision(playerId: PlayerId, now: number): void {
    const i = this.indexOf.get(playerId);
    if (i !== undefined) this.records[i].lastCollisionAt = now;
  }

  /** from の collision を to に中継してよいか (どちらも走っていて、最後の位置が実際に接触しうる距離) */
  canRelayCollision(from: PlayerId, to: PlayerId): boolean {
    const a = this.indexOf.get(from);
    const b = this.indexOf.get(to);
    if (a === undefined || b === undefined || a === b) return false;
    const ca = this.cars[a];
    const cb = this.cars[b];
    if (ca.status === 'retired' || cb.status === 'retired' || this.records[a].isStale || this.records[b].isStale) return false;
    return Math.hypot(ca.car.x - cb.car.x, ca.car.y - cb.car.y) <= this.relayDistance;
  }

  /** 接続が切れた参加者の車をリタイアにする (disconnected を送る) */
  disconnect(playerId: PlayerId, now: number): void {
    const i = this.indexOf.get(playerId);
    if (i !== undefined) this.retire(i, 'disconnected', now);
  }

  /**
   * 時間で進むもの (消灯、状態が届かない車のゴースト・リタイア、チェッカー後の未完走、結果の確定) を進める。
   * このときまでに起きたイベント (周回・ゴール・フライングなど applyState で起きたものを含む) を返す。
   * 返す配列は次の update で使い回す
   */
  update(now: number): readonly RaceEventMessage[] {
    const out = this.events;
    out.length = 0;
    if (this.phase === 'finished') return this.flushPending(out);
    if (this.phase === 'grid' && now >= this.schedule.lightsOutAt) this.phase = 'racing';
    for (let i = 0; i < this.cars.length; i++) {
      const rc = this.cars[i];
      const rec = this.records[i];
      if (rc.status === 'retired') continue;
      const silent = now - rec.lastHeardAt;
      // ゴーストは受け付けた状態から数える (捨てられる状態だけを送り続けて、止まった障害物として残らないように)
      const unaccepted = now - rec.lastAcceptedAt;
      if (!rec.isStale && unaccepted >= netRaceRules.staleGhostMs) {
        rec.isStale = true;
        rec.last.sF = 0;
        rec.last.sR = 0;
        this.push('ghost', rec.playerId, now);
      } else if (rec.isStale && unaccepted < netRaceRules.staleGhostMs && !this.overlapsAny(i)) {
        // 戻るときに他車と重なっていたら、重ならなくなるまでゴーストを延ばす (7.10 節)
        rec.isStale = false;
        this.push('unghost', rec.playerId, now);
      }
      if (rc.status === 'racing' && silent >= netRaceRules.staleRetireMs) this.retire(i, 'retired', now);
    }
    // 先頭のゴールから 30 秒たってもゴールしていない車は未完走
    if (this.isCheckered && this.toSession(now) - this.leaderFinishAt >= this.rules.finishTimeout) {
      for (const rc of this.cars) if (rc.status === 'racing') rc.status = 'unclassified';
    }
    this.updateDistances();
    if (this.cars.every((rc) => rc.status !== 'racing')) this.finalize();
    return this.flushPending(out);
  }

  /**
   * スナップショットに載せる全車の状態を out に書き、台数を返す。位置は状態の時刻から now まで速度で進める (上限 0.1 秒)。
   * 状態が届かない車・ゴールした車・リタイアした車はゴースト
   */
  writeSnapshot(out: CarNetState[], now: number): number {
    for (let i = 0; i < this.cars.length; i++) {
      const rc = this.cars[i];
      const rec = this.records[i];
      while (out.length <= i) out.push(createCarNetState());
      const o = copyNetState(rec.last, out[i], rec.playerId);
      const isMoving = rec.hasState && !rec.isStale && rc.status !== 'retired';
      const ahead = isMoving ? Math.max(0, Math.min(now - rec.lastTime, netRaceRules.snapshotExtrapolateMaxMs)) / 1000 : 0;
      if (ahead > 0) {
        const sin = Math.sin(o.heading);
        const cos = Math.cos(o.heading);
        o.x += (sin * o.sF + cos * o.sR) * ahead;
        o.y += (-cos * o.sF + sin * o.sR) * ahead;
      }
      if (!isMoving) {
        o.sF = 0;
        o.sR = 0;
      }
      o.lap = rc.lap.lap;
      o.checkpoint = rc.lap.nextCheckpoint;
      o.isGhost = rec.isStale || rc.status !== 'racing' || rec.isReportedGhostAllowed;
    }
    return this.cars.length;
  }

  private flushPending(out: RaceEventMessage[]): RaceEventMessage[] {
    for (const e of this.pending) out.push(e);
    this.pending.length = 0;
    return out;
  }

  private ignore(rec: HostCarRecord, detail: string): StateVerdict {
    rec.warnings++;
    this.onWarning?.(rec.playerId, detail);
    return 'ignored';
  }

  /**
   * コース復帰の置き直しとして認めるか: isResetting、前の置き直しから (暗転 + 操作不能 + ゴースト) 以上たっている、
   * ホストが求めた置き直し先から近い、最後に正常に走っていた地点より前に出ていない
   */
  private isValidReset(rc: RaceCar, rec: HostCarRecord, s: CarNetState, t: number): boolean {
    if (!s.isResetting || t - rec.lastResetAt < netRaceRules.resetMinIntervalMs) return false;
    rc.lap.resetPose(this.tmpPose);
    if (Math.hypot(s.x - this.tmpPose.x, s.y - this.tmpPose.y) > netRaceRules.resetSnapRadius) return false;
    this.track.project(s.x, s.y, -1, this.tmpProjection);
    return this.track.deltaS(rc.lap.lastValidS, this.tmpProjection.s) <= netRaceRules.resetForwardTolerancePx;
  }

  /** 前の位置から今の位置までの線分が壁を通るか (インフィールドを横切るショートカットを防ぐ) */
  private crossesWall(x0: number, y0: number, x1: number, y1: number): boolean {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.ceil(len / netRaceRules.wallProbeStepPx);
    for (let k = 1; k < steps; k++) {
      const u = k / steps;
      if (this.track.surfaceCodeAt(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u) === SurfaceCode.wall) return true;
    }
    return false;
  }

  /** コース外 (芝生・砂利) にある車輪の数。ホストは車の物理を計算しないので、位置から求める */
  private countWheelsOffTrack(car: RaceCar['car']): number {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      car.wheelPosition(k as 0 | 1 | 2 | 3, this.tmpPoint);
      if (this.params.surfaces[this.track.surfaceAt(this.tmpPoint.x, this.tmpPoint.y)].isOffTrack) n++;
    }
    return n;
  }

  /**
   * 参加者が申告する isGhost (コース復帰後・ピット出口後) は、ピットレーン内かゴール後か、
   * 申告が続いている時間が上限以内のときだけ認める (ずっとゴーストで走る不正を防ぐ)
   */
  private judgeReportedGhost(rc: RaceCar, rec: HostCarRecord, isGhost: boolean, t: number): void {
    if (!isGhost || rc.lap.isInPitLane) rec.reportedGhostSince = null;
    else rec.reportedGhostSince ??= t;
    rec.isReportedGhostAllowed = isGhost && (
      rc.lap.isInPitLane || rc.status !== 'racing'
      || (rec.reportedGhostSince !== null && t - rec.reportedGhostSince <= netRaceRules.reportedGhostMaxMs)
    );
  }

  private toSession(hostTime: number): number {
    return (hostTime - this.schedule.gridAt) / 1000;
  }

  private push(event: RaceEventKind, playerId: PlayerId, time: number, lap?: number, value?: number): void {
    const e: RaceEventMessage = { type: 'raceEvent', event, playerId, time };
    if (lap !== undefined) e.lap = lap;
    if (value !== undefined) e.value = value;
    this.pending.push(e);
  }

  /**
   * フライング (7.2 節): 消灯前にグリッド位置から 5 px 以上動いた。消灯前の状態が届かなかった場合に備えて、
   * 消灯直後の状態でも、止まった状態から発進して届く距離を超えていれば成立とする。
   * 消灯前に接触していた車は、押されただけかもしれないので判定しない
   */
  private judgeJumpStart(rc: RaceCar, rec: HostCarRecord, t: number): void {
    if (rc.isJumpStart || rec.isStartJudged) return;
    const lightsOut = this.schedule.lightsOutAt;
    if (rec.lastCollisionAt < lightsOut && rec.lastCollisionAt > this.schedule.gridAt - 1000) {
      rec.isStartJudged = t >= lightsOut;
      return;
    }
    const d = Math.hypot(rc.car.x - rc.gridPose.x, rc.car.y - rc.gridPose.y);
    let isJump = false;
    if (t < lightsOut) {
      isJump = d >= this.rules.jumpStartDistance;
    } else {
      const tau = (t - lightsOut) / 1000;
      isJump = d >= this.rules.jumpStartDistance + 0.5 * this.launchAccel * tau * tau;
      rec.isStartJudged = true;
    }
    if (!isJump) return;
    rc.isJumpStart = true;
    rc.penalty += this.rules.jumpStartPenalty;
    this.push('penalty', rec.playerId, t, undefined, this.rules.jumpStartPenalty);
  }

  private handleLapEvent(rc: RaceCar, e: LapEvent): void {
    if (rc.status !== 'racing') return;
    const lines = this.track.timingLines.length;
    switch (e.type) {
      case 'lapStarted':
        if (e.lap >= 2) rc.lapStartAt = e.time;
        recordTiming(rc, e.lap * lines, e.time);
        break;
      case 'timingLine':
        recordTiming(rc, e.lap * lines + e.index, e.at);
        break;
      case 'lapCompleted':
        this.completeLap(rc, e.lap, e.at - rc.lapStartAt, e.valid, e.at);
        break;
      default:
        break;
    }
  }

  private completeLap(rc: RaceCar, lap: number, time: number, valid: boolean, at: number): void {
    const rec = this.records[rc.index];
    const hostAt = this.schedule.gridAt + at * 1000;
    rc.lapsCompleted = lap;
    rc.lastLap = time;
    rc.lapTimes.push(time);
    this.bests.classifyLap(rc, time, valid);
    this.push('lap', rec.playerId, hostAt, lap, time);
    // チェッカー (7.7 節): 先頭が規定周回を終えたら、以降は各車が次にコントロールラインを通った時点でゴール
    if (!this.isCheckered && lap >= this.totalLaps) {
      this.isCheckered = true;
      this.leaderFinishAt = at;
    }
    if (this.isCheckered) {
      rc.status = 'finished';
      rc.finishTime = at - this.lightsOutAt;
      rc.finishOrder = this.finishCount++;
      rc.distance = lap * this.track.length;
      this.push('finish', rec.playerId, hostAt, lap, rc.finishTime);
    }
  }

  private retire(i: number, kind: 'retired' | 'disconnected', now: number): void {
    const rc = this.cars[i];
    if (rc.status === 'retired' || this.phase === 'finished') return;
    // ゴール・未完走が決まった車は結果を変えない (切断してもゴールは有効)
    if (rc.status === 'finished' || rc.status === 'unclassified') {
      if (kind === 'disconnected') this.push('disconnected', this.records[i].playerId, now);
      return;
    }
    rc.status = 'retired';
    this.push(kind, this.records[i].playerId, now);
  }

  private overlapsAny(i: number): boolean {
    const self = this.cars[i];
    for (let j = 0; j < this.cars.length; j++) {
      const rc = this.cars[j];
      if (j === i || rc.status !== 'racing' || this.records[j].isStale) continue;
      if (Math.abs(rc.distance - self.distance) >= this.track.length * this.rules.lappedGhostRatio) continue;
      if (detectContact(self.car, rc.car, this.tmpContact)) return true;
    }
    return false;
  }

  private updateDistances(): void {
    for (const rc of this.cars) {
      if (rc.status !== 'racing') continue;
      rc.distance = raceDistanceOf(this.track, rc.lap.lap, rc.lap.nextCheckpoint, rc.lap.projection.s);
    }
  }

  private finalize(): void {
    this.phase = 'finished';
    const byCar = new Map<number, PlayerId>();
    for (let i = 0; i < this.cars.length; i++) byCar.set(this.cars[i].carNumber, this.records[i].playerId);
    this.results = buildRaceResults(this.cars, this.track).map((r) => ({
      playerId: byCar.get(r.carNumber)!,
      position: r.position,
      status: r.status,
      totalTime: r.totalTime,
      bestLap: r.bestLap,
      lapsCompleted: r.lapsCompleted,
      penalty: r.penalty,
    }));
  }
}

function copyNetState(from: CarNetState, to: CarNetState, id: PlayerId): CarNetState {
  to.id = id;
  to.x = from.x;
  to.y = from.y;
  to.heading = from.heading;
  to.sF = from.sF;
  to.sR = from.sR;
  to.steer = from.steer;
  to.lap = from.lap;
  to.checkpoint = from.checkpoint;
  to.isDrsOpen = from.isDrsOpen;
  to.isBraking = from.isBraking;
  to.isReversing = from.isReversing;
  to.isGhost = from.isGhost;
  to.isInPit = from.isInPit;
  to.isSpinning = from.isSpinning;
  to.isResetting = from.isResetting;
  return to;
}
