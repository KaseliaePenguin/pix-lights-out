import type { CarParams, CpuDifficulty, RaceSessionRules } from './carParams';
import { carParams, raceRules, raceSessionRules } from './carParams';
import type { ContactResult } from './carContact';
import { detectContact } from './carContact';
import { ContactSystem } from './ContactSystem';
import type { Controls } from './controls';
import { clearControls, copyControls } from './controls';
import type { CpuSurroundings } from './CpuDriver';
import { CpuDriver, createCpuSurroundings } from './CpuDriver';
import type { LapEvent } from './LapTracker';
import { approach } from './math';
import { RaceCar, gapNone } from './RaceCar';
import type { RaceGap } from './raceGap';
import type { RaceCarStepContext } from './raceCarSteps';
import { driveRaceCar } from './raceCarSteps';
import { RacingLine } from './RacingLine';
import { Random } from './Random';
import {
  buildRaceResults, isBlueFlagged, isLappedPair, provisionalPosition, raceDistanceOf, recordTiming, SessionBests, sortStandings,
  updateRaceGaps,
} from './raceStandings';
import { isInSlipstream } from './slipstream';
import type { TimingResult } from './TimeAttackSession';
import type { Car } from './Car';
import type { Track } from './Track';

export interface RaceConfig {
  track: Track;
  /** 周回数 (3 / 5) */
  totalLaps: number;
  /** プレイヤーの車番 (1〜8)。null なら全車 CPU (タイトル画面の背景・sim) */
  playerCarNumber: number | null;
  /** CPU の台数 (1〜7。全車 CPU のときは 1〜8) */
  cpuCount: number;
  difficulty: CpuDifficulty;
  /** 乱数の seed。同じ seed・同じ入力なら同じレースになる */
  seed: number;
  /** CPU が追うレーシングライン (作るのに数百ミリ秒かかるので、シーンで 1 回作って使い回せる)。省略すると作る */
  racingLine?: RacingLine;
  params?: Readonly<CarParams>;
  rules?: Readonly<RaceSessionRules>;
}

/** grid = グリッドに並んでスタートランプの点灯を待つ (消灯まで)、racing = レース中、finished = 結果が確定した */
export type RacePhase = 'grid' | 'racing' | 'finished';

export type RaceEvent =
  /** スタートランプが count 個目まで点灯した (start-light-on) */
  | { type: 'lampOn'; count: number }
  /** 全消灯 = スタート (start-go。レース BGM を頭から) */
  | { type: 'lightsOut' }
  /** フライングが成立した (false-start、JUMP START +3 SEC) */
  | { type: 'jumpStart'; carNumber: number }
  /** 反応時間 (REACTION 0.231) */
  | { type: 'reaction'; carNumber: number; time: number }
  /** 周回の判定 (LapTracker のイベント: 区間・周回・チェックポイント未通過・逆走など) */
  | { type: 'lap'; carNumber: number; event: LapEvent }
  /** 区間タイムと色 (1 周目の S1 は消灯から) */
  | { type: 'sectorResult'; carNumber: number; lap: number; index: number; time: number; result: TimingResult }
  /** ラップタイムと色 (1 周目は消灯から) */
  | { type: 'lapResult'; carNumber: number; lap: number; time: number; result: TimingResult }
  /** 全体ベストラップの更新 (1 周目は除く。FASTEST LAP) */
  | { type: 'fastestLap'; carNumber: number; lap: number; time: number }
  /** 先頭が最終周に入った (FINAL LAP) */
  | { type: 'finalLap' }
  /** 先頭が規定周回を終えた (チェッカーフラッグ) */
  | { type: 'checkeredFlag'; carNumber: number }
  /** ゴールした。position は確定していれば確定順位、まだなら見込み (ペナルティを含まない) */
  | { type: 'carFinished'; carNumber: number; position: number; time: number }
  /** 結果が確定した (session.results を読む) */
  | { type: 'raceFinished' }
  /** 車同士の接触 (火花・crash-car・画面揺れ)。impact は J (px/秒) */
  | { type: 'contact'; carA: number; carB: number; impact: number; x: number; y: number; spinA: boolean; spinB: boolean }
  /** BLUE FLAG が出た (状態は RaceCar.isBlueFlag) */
  | { type: 'blueFlag'; carNumber: number }
  /** 検知ラインで DRS の使用権を得た (drs-available) */
  | { type: 'drsAvailable'; carNumber: number }
  /** 使える状態で DRS 区間に入った (DRS ENABLED) */
  | { type: 'drsEnabled'; carNumber: number }
  | { type: 'drsOpened'; carNumber: number }
  | { type: 'drsClosed'; carNumber: number }
  | { type: 'resetStarted'; carNumber: number }
  /** 条件を満たさないのにコース復帰を押した (プレイヤーだけ。ui-error) */
  | { type: 'resetRejected'; carNumber: number }
  | { type: 'resetPlaced'; carNumber: number }
  | { type: 'resetFinished'; carNumber: number }
  | { type: 'retired'; carNumber: number }
  /** 先頭のゴールから 30 秒たってもゴールしていない (未完走) */
  | { type: 'unclassified'; carNumber: number };

/** 確定した結果 1 台分 (リザルト画面用) */
export interface RaceResult {
  carNumber: number;
  isPlayer: boolean;
  position: number;
  /** finished = 完走、unclassified = 未完走、retired = リタイア (DNF) */
  status: 'finished' | 'unclassified' | 'retired';
  lapsCompleted: number;
  /** ゴールタイム (ペナルティを含まない)。完走でなければ null */
  finishTime: number | null;
  penalty: number;
  /** ゴールタイム + ペナルティ。完走でなければ null */
  totalTime: number | null;
  /** 優勝者との差 (優勝者は leader、周回遅れ・未完走は laps、リタイアは out) */
  gapToWinner: RaceGap;
  bestLap: number | null;
  isJumpStart: boolean;
  /** 1 人用でプレイヤーのゴール時に推定したタイム */
  isEstimated: boolean;
}

/** 順位表の 1 行を作るのに要る値 (src/ui/standingsPanel.ts の StandingsRow に合わせた形) */
export interface StandingsEntry {
  carNumber: number;
  isPlayer: boolean;
  gap: RaceGap;
  hasFastestLap: boolean;
}

/**
 * 決勝 1 回分の進行 (game-design.md 7 章・9 章、car-physics.md 9.1・11・12 節)。DOM に依存しない。
 * シーンは毎フレーム step(playerControls, dt) を呼び、返ってきたイベントで音・メッセージ帯を出し、
 * cars / order / RaceCar の値を描画に使う。M2 の範囲: 予選なし (予選スキップのグリッド)、ピットなし、ソフト固定で摩耗なし。
 */
export class RaceSession {
  readonly track: Track;
  readonly totalLaps: number;
  readonly rules: Readonly<RaceSessionRules>;
  readonly racingLine: RacingLine;
  /** 車番 1〜8 の順ではなく、グリッド順 (cars[0] がポール) */
  readonly cars: readonly RaceCar[];
  /** プレイヤーの車 (全車 CPU なら null) */
  readonly player: RaceCar | null;
  /** 今の順位の並び (先頭から)。毎フレーム並べ直す */
  readonly order: RaceCar[];
  /** order の車番 (PositionChangeTracker.update にそのまま渡せる) */
  readonly orderNumbers: number[];
  /** CPU の予選タイム (計算値、7.8 節)。グリッドの並びの根拠 */
  readonly qualifyingTimes: ReadonlyMap<number, number>;

  phase: RacePhase = 'grid';
  /** セッションの経過時間 (グリッドに並んだ時点が 0) */
  time = 0;
  /** 消灯の時刻 (セッションの時刻)。消灯前でも決まっている */
  readonly lightsOutAt: number;
  /** 点灯しているスタートランプの数 (0〜5)。消灯後は 0 */
  litLamps = 0;
  /** チェッカーが出たか・先頭のゴール時刻 */
  isCheckered = false;
  /** 確定した結果 (phase が finished になってから) */
  results: readonly RaceResult[] = [];

  private readonly contacts: ContactSystem;
  private readonly carList: Car[];
  private readonly events: RaceEvent[] = [];
  private readonly pendingEvents: RaceEvent[] = [];
  private readonly bests = new SessionBests();
  private readonly surroundings: CpuSurroundings & { others: Car[] };
  private readonly tmpContact: ContactResult = { depth: 0, nx: 0, ny: 0, x: 0, y: 0 };
  private readonly stepContext: RaceCarStepContext;
  private readonly finishedNow: RaceCar[] = [];
  private readonly isGhostPairBound: (a: number, b: number) => boolean;
  private leaderFinishAt = 0;
  private finishCount = 0;
  private isFinalLapAnnounced = false;

  constructor(config: RaceConfig) {
    const track = config.track;
    const params = config.params ?? carParams;
    this.track = track;
    this.totalLaps = config.totalLaps;
    this.rules = config.rules ?? raceSessionRules;
    this.racingLine = config.racingLine ?? new RacingLine(track, { tyreGrip: params.compoundGrip.soft, params });
    const random = new Random(config.seed);

    // 参加者: プレイヤー + 残りのチームを車番の小さい順に CPU
    const numbers: number[] = [];
    for (let n = 1; n <= 8; n++) if (n !== config.playerCarNumber) numbers.push(n);
    const maxCpu = config.playerCarNumber === null ? 8 : 7;
    const cpuNumbers = numbers.slice(0, Math.max(1, Math.min(maxCpu, config.cpuCount)));

    // CPU の運転と予選タイム (予選スキップ、7.3・7.8 節)
    const drivers = new Map<number, CpuDriver>();
    const quali = new Map<number, number>();
    const tyre = params.compoundGrip.soft;
    for (const n of cpuNumbers) {
      const driverRandom = new Random(Math.floor(random.next() * 4294967296));
      drivers.set(n, new CpuDriver(this.racingLine, track, config.difficulty, driverRandom, tyre));
    }
    const reference = track.referenceLapTime ?? this.racingLine.lapTimeOf(this.racingLine.computeSpeeds({ skill: 1, tyreGrip: tyre }));
    for (const n of cpuNumbers) {
      const skill = drivers.get(n)!.skill;
      const noise = random.range(this.rules.qualifyingNoiseMin, this.rules.qualifyingNoiseMax);
      quali.set(n, reference * (1 + (1 - skill) * this.rules.qualifyingSkillFactor) + noise);
    }
    this.qualifyingTimes = quali;
    const gridOrder = cpuNumbers.slice().sort((a, b) => quali.get(a)! - quali.get(b)! || a - b);
    if (config.playerCarNumber !== null) gridOrder.push(config.playerCarNumber);

    const cars = gridOrder.map((n, slot) => {
      const rc = new RaceCar(n, n === config.playerCarNumber, slot, slot, track.gridSlots[slot], drivers.get(n) ?? null, track, this.totalLaps, params);
      rc.car.placeAt(rc.gridPose);
      rc.lap.resetForStart(rc.car);
      rc.prevS = rc.lap.projection.s;
      return rc;
    });
    this.cars = cars;
    this.carList = cars.map((rc) => rc.car);
    this.player = cars.find((rc) => rc.isPlayer) ?? null;
    this.order = cars.slice();
    this.orderNumbers = cars.map((rc) => rc.carNumber);
    this.contacts = new ContactSystem(cars.length);
    this.surroundings = createCpuSurroundings(cars.length);
    this.isGhostPairBound = (a, b) => this.isGhostPair(a, b);
    this.stepContext = {
      dt: 0, isStarted: false, tPrev: 0, lightsOutAt: 0, events: this.events,
      isResetAvailable: (rc) => this.isResetAvailable(rc),
      overlapsAny: (rc) => this.overlapsAny(rc),
      handleLapEvent: (rc, e) => this.handleLapEvent(rc, e),
      tmpPose: { x: 0, y: 0, heading: 0 },
    };

    const lampsDone = this.rules.firstLampDelay + this.rules.lampInterval * (this.rules.lampCount - 1);
    this.lightsOutAt = lampsDone + random.range(this.rules.lightsOutWaitMin, this.rules.lightsOutWaitMax);
    this.updateDistances();
    this.updateOrder();
  }

  /** 全体ベストラップとその車番 (まだなければ null) */
  get fastestLap(): number | null {
    return this.bests.fastestLap;
  }

  get fastestLapCarNumber(): number | null {
    return this.bests.fastestLapCarNumber;
  }

  /** 消灯からの経過時間 (消灯前は 0) */
  get raceTime(): number {
    return Math.max(0, this.time - this.lightsOutAt);
  }

  /** 順位表の見出しの周 (先頭の車の周、1〜totalLaps) */
  get leaderLap(): number {
    return this.order[0].displayLap(this.totalLaps);
  }

  carByNumber(carNumber: number): RaceCar | null {
    return this.cars.find((rc) => rc.carNumber === carNumber) ?? null;
  }

  /** 順位表の行の元データ (先頭から)。out に詰めて返す (毎フレーム配列を作らないため) */
  standings(out: StandingsEntry[]): StandingsEntry[] {
    for (let i = 0; i < this.order.length; i++) {
      const rc = this.order[i];
      if (i >= out.length) out.push({ carNumber: 0, isPlayer: false, gap: gapNone, hasFastestLap: false });
      const e = out[i];
      e.carNumber = rc.carNumber;
      e.isPlayer = rc.isPlayer;
      e.gap = rc.gapToAhead;
      e.hasFastestLap = rc.carNumber === this.fastestLapCarNumber;
    }
    out.length = this.order.length;
    return out;
  }

  /** そのプレイヤーの車がコース復帰を使えるか (PRESS R TO RESET) */
  isResetAvailable(rc: RaceCar): boolean {
    return (
      this.phase !== 'grid' &&
      rc.status !== 'retired' &&
      rc.resetTimer < 0 &&
      rc.ghostTimeRemaining <= 0 &&
      // グリッドで止まっていた時間を「低速が続いた」と数えないよう、消灯から低速の判定時間が過ぎるまでは出さない
      this.time - this.lightsOutAt >= raceRules.resetSlowTime &&
      rc.lap.isResetAvailable(rc.car)
    );
  }

  /**
   * 2 台がすり抜ける組み合わせか (7.10 節)。cars の番号で指定する。
   * どちらかがゴースト状態、または進行距離の差が 1 周の半分以上 (周回遅れの関係)。描画でゴーストに見せる判定にも使う
   */
  isGhostPair(a: number, b: number): boolean {
    const ca = this.cars[a];
    const cb = this.cars[b];
    if (ca.isGhost || cb.isGhost) return true;
    return isLappedPair(this.track, ca, cb, this.rules);
  }

  /** リタイア (ポーズメニューの RETIRE)。1 人用でプレイヤーがリタイアしたら、その場で結果を確定する */
  retire(carNumber: number): void {
    const rc = this.carByNumber(carNumber);
    if (!rc || rc.status === 'retired' || this.phase === 'finished') return;
    rc.status = 'retired';
    rc.car.controlLocked = true;
    rc.car.closeDrs();
    this.pendingEvents.push({ type: 'retired', carNumber });
    this.updateOrder();
    if (rc.isPlayer) this.finalize(true, this.pendingEvents);
  }

  /**
   * 1 フレーム進める。playerControls はプレイヤーの入力 (全車 CPU なら null)。
   * 返す配列は次の step で使い回す
   */
  step(playerControls: Controls | null, dt: number): readonly RaceEvent[] {
    this.events.length = 0;
    for (const e of this.pendingEvents) this.events.push(e);
    this.pendingEvents.length = 0;
    const tPrev = this.time;
    this.time += dt;
    this.updateStartLights(tPrev);
    const isStarted = this.phase !== 'grid';

    // 1. 入力とコース復帰、DRS、車の物理
    const ctx = this.stepContext;
    ctx.dt = dt;
    ctx.isStarted = isStarted;
    ctx.tPrev = tPrev;
    ctx.lightsOutAt = this.lightsOutAt;
    for (const rc of this.cars) {
      const car = rc.car;
      if (rc.status === 'retired') {
        clearControls(rc.controls);
      } else if (rc.isPlayer) {
        if (playerControls) copyControls(playerControls, rc.controls);
        else clearControls(rc.controls);
      } else if (rc.driver) {
        this.fillSurroundings(rc, isStarted, tPrev);
        rc.driver.update(car, this.surroundings, dt, rc.controls);
      }
      driveRaceCar(rc, ctx);
    }

    // 2. 車同士の接触 (全車の移動後)
    for (const c of this.contacts.step(this.carList, this.isGhostPairBound, this.time)) {
      this.events.push({
        type: 'contact',
        carA: this.cars[c.indexA].carNumber,
        carB: this.cars[c.indexB].carNumber,
        impact: c.impact,
        x: c.x,
        y: c.y,
        spinA: c.spinA,
        spinB: c.spinB,
      });
    }

    // 3. スリップストリーム (決勝のみ・スタート後)
    this.updateSlipstream(isStarted, dt);

    // 4. 周回・タイミング
    this.finishedNow.length = 0;
    for (const rc of this.cars) {
      const lapEvents = rc.lap.update(rc.car, dt);
      if (rc.resetTimer >= 0 || rc.ghostTimeRemaining > 0) rc.lap.holdResetConditions();
      for (const e of lapEvents) this.handleLapEvent(rc, e);
      this.detectDrsLine(rc, dt);
      if (this.phase === 'grid' && !rc.isJumpStart && rc.status === 'racing') this.checkJumpStart(rc);
      if (isStarted && rc.status === 'racing') rc.currentLapTime = this.time - rc.lapStartAt;
      rc.ghostBlinkTime = rc.isGhostBlinking ? rc.ghostBlinkTime + dt : 0;
    }
    this.updateDrsEligibility();

    // 5. 順位・差・BLUE FLAG・レースの終わり
    this.updateDistances();
    if (this.phase !== 'finished') {
      this.updateTimeout();
      this.updateOrder();
      this.updateGaps();
      this.updateBlueFlags();
      this.checkFinalize();
    }
    for (const rc of this.finishedNow) {
      const position = this.phase === 'finished' ? this.resultPosition(rc.carNumber) : provisionalPosition(rc, this.cars);
      this.events.push({ type: 'carFinished', carNumber: rc.carNumber, position, time: rc.finishTime ?? 0 });
    }
    return this.events;
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
      for (const rc of this.cars) {
        rc.lapStartAt = this.lightsOutAt;
        rc.sectorStartAt = this.lightsOutAt;
      }
      this.events.push({ type: 'lightsOut' });
    }
  }

  /** 他車に押されて動いただけではフライングにしない (自分でアクセル・ブレーキを踏んだ車だけ) */
  private checkJumpStart(rc: RaceCar): void {
    if (!rc.hasGridInput) return;
    const dx = rc.car.x - rc.gridPose.x;
    const dy = rc.car.y - rc.gridPose.y;
    if (dx * dx + dy * dy < this.rules.jumpStartDistance * this.rules.jumpStartDistance) return;
    rc.isJumpStart = true;
    rc.penalty += this.rules.jumpStartPenalty;
    this.events.push({ type: 'jumpStart', carNumber: rc.carNumber });
  }

  // ------------------------------------------------------------------
  // CPU

  private fillSurroundings(self: RaceCar, isStarted: boolean, tPrev: number): void {
    const env = this.surroundings;
    let count = 0;
    for (const rc of this.cars) {
      if (rc === self || this.isGhostPair(self.index, rc.index)) continue;
      env.others[count++] = rc.car;
    }
    env.othersCount = count;
    env.canDrive = isStarted && self.status !== 'retired';
    env.timeSinceStart = tPrev - this.lightsOutAt;
    env.wantsReset = self.lap.isWrongWay || self.lap.isCheckpointMissed;
  }

  // ------------------------------------------------------------------
  // コース復帰 (7.11 節) の手順は raceCarSteps.ts の updateResetProcedure

  /** ゴーストでない相手と当たり判定が重なっているか (ゴーストの延長の判定) */
  private overlapsAny(self: RaceCar): boolean {
    for (const rc of this.cars) {
      if (rc === self || rc.isGhost) continue;
      if (isLappedPair(this.track, rc, self, this.rules)) continue;
      if (detectContact(self.car, rc.car, this.tmpContact)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // スリップストリーム (car-physics.md 11 節)

  private updateSlipstream(isStarted: boolean, dt: number): void {
    for (const m of this.cars) {
      let active = false;
      if (isStarted && m.status !== 'retired') {
        for (const l of this.cars) {
          if (l === m || l.status === 'retired' || this.isGhostPair(m.index, l.index)) continue;
          if (isInSlipstream(m.car, l.car)) {
            active = true;
            break;
          }
        }
      }
      const p = m.car.params;
      m.car.fSlip = approach(m.car.fSlip, active ? 1 : 0, p.slipRate * dt);
    }
  }

  // ------------------------------------------------------------------
  // DRS (7.6 節): 2 周目以降、検知ラインで前の車との差が 1.000 秒以内なら、その周の区間で使える

  private detectDrsLine(rc: RaceCar, dt: number): void {
    const s = rc.lap.projection.s;
    const det = this.track.drsDetectionS;
    const moved = this.track.deltaS(rc.prevS, s);
    const before = this.track.deltaS(rc.prevS, det);
    rc.drsDetectionCrossedAt = -1;
    if (moved > 0 && moved < 60 && before > 0 && before <= moved) {
      rc.drsDetectionCrossedAt = this.time - dt + (before / moved) * dt;
    }
    rc.prevS = s;
  }

  /** 同じフレームに複数の車が検知ラインを通っても順番に左右されないよう、全車の通過を記録してから判定する */
  private updateDrsEligibility(): void {
    for (const rc of this.cars) {
      const at = rc.drsDetectionCrossedAt;
      if (at < 0) continue;
      let eligible = false;
      if (this.phase === 'racing' && rc.status === 'racing' && rc.lap.lap >= this.rules.drsMinLap) {
        for (const o of this.cars) {
          if (o === rc || o.status === 'retired' || o.lap.isInPitLane) continue;
          const t = o.drsDetectionCrossedAt >= 0 ? o.drsDetectionCrossedAt : o.lastDrsDetectionAt;
          if (t <= at && at - t <= this.rules.drsGapThreshold) {
            eligible = true;
            break;
          }
        }
      }
      rc.isDrsEligible = eligible;
      if (eligible) this.events.push({ type: 'drsAvailable', carNumber: rc.carNumber });
    }
    for (const rc of this.cars) if (rc.drsDetectionCrossedAt >= 0) rc.lastDrsDetectionAt = rc.drsDetectionCrossedAt;
  }

  // ------------------------------------------------------------------
  // 周回・区間・タイミングライン

  private handleLapEvent(rc: RaceCar, e: LapEvent): void {
    this.events.push({ type: 'lap', carNumber: rc.carNumber, event: e });
    if (this.phase === 'finished' || rc.status !== 'racing') return;
    const lines = this.track.timingLines.length;
    switch (e.type) {
      case 'lapStarted':
        // 1 周目の開始は消灯の時刻 (消灯時に設定済み)
        if (e.lap >= 2) {
          rc.lapStartAt = e.time;
          rc.sectorStartAt = e.time;
        }
        rc.sectorResults.fill('none');
        recordTiming(rc, e.lap * lines, e.time);
        if (e.lap === this.totalLaps && !this.isFinalLapAnnounced && !this.isCheckered) {
          this.isFinalLapAnnounced = true;
          this.events.push({ type: 'finalLap' });
        }
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
      case 'lapCompleted':
        this.completeLap(rc, e.lap, e.at - rc.lapStartAt, e.valid, e.at);
        break;
      case 'pitExit':
        rc.pitGhostRemaining = this.rules.pitExitGhostTime;
        break;
      default:
        break;
    }
  }

  private completeLap(rc: RaceCar, lap: number, time: number, valid: boolean, at: number): void {
    rc.lapsCompleted = lap;
    rc.lastLap = time;
    rc.lapTimes.push(time);
    const result = this.bests.classifyLap(rc, time, valid);
    if (result === 'overall' && lap >= 2) this.events.push({ type: 'fastestLap', carNumber: rc.carNumber, lap, time });
    rc.lastLapResult = result;
    this.events.push({ type: 'lapResult', carNumber: rc.carNumber, lap, time, result });

    // チェッカー (7.7 節): 先頭が規定周回を終えたら、以降は各車が次にコントロールラインを通った時点でゴール
    if (!this.isCheckered && lap >= this.totalLaps) {
      this.isCheckered = true;
      this.leaderFinishAt = at;
      this.events.push({ type: 'checkeredFlag', carNumber: rc.carNumber });
    }
    if (this.isCheckered) {
      rc.status = 'finished';
      rc.finishTime = at - this.lightsOutAt;
      rc.finishOrder = this.finishCount++;
      rc.distance = lap * this.track.length;
      rc.currentLapTime = time;
      rc.car.closeDrs();
      this.finishedNow.push(rc);
    }
  }

  // ------------------------------------------------------------------
  // 順位とタイム差 (7.5 節)

  private updateDistances(): void {
    for (const rc of this.cars) {
      if (rc.status !== 'racing') continue;
      rc.distance = raceDistanceOf(this.track, rc.lap.lap, rc.lap.nextCheckpoint, rc.lap.projection.s);
    }
  }

  /** 先頭のゴールから 30 秒たってもゴールしていない車は未完走 */
  private updateTimeout(): void {
    if (!this.isCheckered || this.time - this.leaderFinishAt < this.rules.finishTimeout) return;
    for (const rc of this.cars) {
      if (rc.status !== 'racing') continue;
      rc.status = 'unclassified';
      rc.car.closeDrs();
      this.events.push({ type: 'unclassified', carNumber: rc.carNumber });
    }
  }

  /** 並べ替え (安定な挿入ソート。同じ値なら前のフレームの並びを保つ) */
  private updateOrder(): void {
    sortStandings(this.order, this.orderNumbers);
  }

  private updateGaps(): void {
    updateRaceGaps(this.order, this.track);
  }

  /** BLUE FLAG (7.10 節): 周回遅れにする側の車が、後ろ 190 px 以内に来た */
  private updateBlueFlags(): void {
    for (const x of this.cars) {
      const blue = this.phase === 'racing' && isBlueFlagged(x, this.cars, this.track, this.rules);
      if (blue && !x.isBlueFlag) this.events.push({ type: 'blueFlag', carNumber: x.carNumber });
      x.isBlueFlag = blue;
    }
  }

  private resultPosition(carNumber: number): number {
    return this.results.find((r) => r.carNumber === carNumber)?.position ?? 0;
  }

  // ------------------------------------------------------------------
  // 結果の確定 (7.7 節)

  private checkFinalize(): void {
    if (this.phase !== 'racing') return;
    if (this.player) {
      if (this.player.status !== 'racing') this.finalize(true, this.events);
      return;
    }
    for (const rc of this.cars) if (rc.status === 'racing') return;
    this.finalize(false, this.events);
  }

  /**
   * 結果を確定する。estimate が true なら、まだ走っている車のゴールタイムを
   * 「残り距離 ÷ 直近 1 周の平均速度」で推定する (1 人用でプレイヤーがゴール・リタイアしたとき)
   */
  private finalize(estimate: boolean, events: RaceEvent[]): void {
    if (estimate) this.estimateRemaining();
    this.phase = 'finished';
    this.results = buildRaceResults(this.cars, this.track);
    this.updateOrder();
    events.push({ type: 'raceFinished' });
  }

  private estimateRemaining(): void {
    const L = this.track.length;
    const now = this.time;
    const running = this.cars.filter((rc) => rc.status === 'racing');
    if (running.length === 0) return;
    const speedOf = (rc: RaceCar): number => {
      if (rc.lastLap !== null && rc.lastLap > 0) return L / rc.lastLap;
      const t = now - this.lightsOutAt;
      return t > 0 && rc.distance > 0 ? rc.distance / t : 1;
    };
    // チェッカーがまだなら、先頭が規定周回を終える時刻を推定する
    let leaderAt = this.leaderFinishAt;
    if (!this.isCheckered) {
      leaderAt = Infinity;
      for (const rc of running) leaderAt = Math.min(leaderAt, now + (this.totalLaps * L - rc.distance) / speedOf(rc));
    }
    for (const rc of running) {
      const v = speedOf(rc);
      // チェッカー以降に最初にコントロールラインを通る周
      let k = Math.max(1, Math.ceil(rc.distance / L + 1e-9));
      let at = now + (k * L - rc.distance) / v;
      while (at < leaderAt) {
        k++;
        at = now + (k * L - rc.distance) / v;
      }
      rc.isEstimated = true;
      if (at - leaderAt > this.rules.finishTimeout) {
        rc.status = 'unclassified';
        rc.distance += (leaderAt + this.rules.finishTimeout - now) * v;
        rc.lapsCompleted = Math.floor(rc.distance / L);
      } else {
        rc.status = 'finished';
        rc.lapsCompleted = k;
        rc.distance = k * L;
        rc.finishTime = at - this.lightsOutAt;
        rc.finishOrder = this.finishCount++;
      }
    }
  }
}
