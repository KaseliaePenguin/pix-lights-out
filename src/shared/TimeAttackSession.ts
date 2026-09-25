import { Car } from './Car';
import type { CarParams } from './carParams';
import { carParams, raceRules, recordVersionOf } from './carParams';
import type { Controls } from './controls';
import { DrsController } from './DrsController';
import type { GhostData } from './ghost';
import { GhostPlayer, GhostRecorder, isGhostCompatible } from './ghost';
import type { LapEvent } from './LapTracker';
import { LapTracker } from './LapTracker';
import type { Pose, Track } from './Track';
import { VirtualGearbox } from './VirtualGearbox';

/** 区間・ラップの色分け (game-design.md 10.1 節): 紫 / 緑 / 黄 / 灰 */
export type TimingResult = 'overall' | 'personal' | 'slower' | 'none';

/** タイムアタックの保存データ (コースごと) */
export interface TimeAttackRecord {
  /** recordVersionOf(track) の値 (物理とコースデータのバージョンの組)。今と違えば使わない */
  recordVersion: string;
  trackId: string;
  bestLap: number | null;
  /** 保存されている全期間の最速区間 (紫の判定に使う) */
  bestSectors: (number | null)[];
  ghost: GhostData | null;
}

export type TimeAttackEvent =
  | LapEvent
  /** カウントダウン 3・2・1 (予選・タイムアタックの発進前) */
  | { type: 'countdown'; value: number }
  | { type: 'go' }
  | { type: 'sectorResult'; index: number; time: number; result: TimingResult }
  | { type: 'lapResult'; lap: number; time: number; result: TimingResult; isNewRecord: boolean }
  /** 自己ベストが更新された。record を保存する */
  | { type: 'recordUpdated'; record: TimeAttackRecord }
  /** タイミングラインでのゴースト差 (負 = ゴーストより速い) */
  | { type: 'ghostDelta'; delta: number }
  | { type: 'resetStarted' }
  /** 条件を満たさないのにコース復帰を押した (ui-error を鳴らす) */
  | { type: 'resetRejected' }
  | { type: 'resetPlaced' }
  | { type: 'resetFinished' }
  | { type: 'drsEnabled' }
  | { type: 'drsOpened' }
  | { type: 'drsClosed' };

export type TimeAttackPhase = 'countdown' | 'running';

export function createEmptyRecord(track: Track): TimeAttackRecord {
  return { recordVersion: recordVersionOf(track), trackId: track.id, bestLap: null, bestSectors: [null, null, null], ghost: null };
}

/**
 * タイムアタック 1 回分の進行 (DOM に依存しない)。シーンは毎フレーム step(controls, dt) を呼び、
 * 返ってきたイベントで HUD・音を更新し、car・lap・drs・gearbox などの状態を描画に使う。
 */
export class TimeAttackSession {
  readonly car: Car;
  readonly lap: LapTracker;
  readonly drs: DrsController;
  readonly gearbox = new VirtualGearbox();
  phase: TimeAttackPhase = 'countdown';
  /** カウントダウンの残り (秒) */
  countdownRemaining = raceRules.countdownTime;

  /** 保存されている記録 (自己ベストが更新されると差し替わる) */
  record: TimeAttackRecord;
  /** このセッションのベスト */
  sessionBestLap: number | null = null;
  readonly sessionBestSectors: (number | null)[] = [null, null, null];
  /** 前の周のタイム (無効な周も入る) と色 */
  lastLap: number | null = null;
  lastLapResult: TimingResult = 'none';
  /** 現在の周の区間の色 (未通過は none) */
  readonly sectorResults: TimingResult[] = ['none', 'none', 'none'];
  /** 最後に通過したタイミングラインでのゴースト差 (まだなければ null) */
  ghostDelta: number | null = null;

  /** コース復帰: 画面の暗さ 0〜1、操作不能の残り秒、復帰後のゴースト (すり抜け・点滅) の残り秒 */
  screenFade = 0;
  resetLockRemaining = 0;
  ghostTimeRemaining = 0;

  private ghostPlayer: GhostPlayer | null = null;
  private readonly recorder = new GhostRecorder();
  private resetTimer = -1;
  private readonly events: TimeAttackEvent[] = [];
  private readonly tmpPose: Pose = { x: 0, y: 0, heading: 0 };
  private lastCountdownValue = 0;

  /** params はテスト用 (通常は既定の carParams) */
  constructor(readonly track: Track, savedRecord: TimeAttackRecord | null = null, params: Readonly<CarParams> = carParams) {
    this.car = new Car(track, params);
    this.car.compound = 'soft';
    this.car.wear = 0;
    this.lap = new LapTracker(track);
    this.drs = new DrsController(track, 'free');
    this.record = isRecordUsable(savedRecord, track) ? cloneRecord(savedRecord) : createEmptyRecord(track);
    if (this.record.ghost && !isGhostCompatible(this.record.ghost, track.id, track.version)) this.record.ghost = null;
    if (this.record.ghost) this.ghostPlayer = new GhostPlayer(this.record.ghost);
    this.restart();
  }

  /** 開始位置に戻してカウントダウンからやり直す (ポーズメニューのリスタート) */
  restart(): void {
    this.car.placeAt(this.track.soloStart);
    this.car.controlLocked = true;
    this.lap.resetForStart(this.car);
    this.gearbox.reset();
    this.recorder.cancel();
    this.phase = 'countdown';
    this.countdownRemaining = raceRules.countdownTime;
    this.lastCountdownValue = 0;
    this.sectorResults.fill('none');
    this.ghostDelta = null;
    this.resetTimer = -1;
    this.screenFade = 0;
    this.resetLockRemaining = 0;
    this.ghostTimeRemaining = 0;
  }

  /** コース復帰が今使えるか (PRESS R TO RESET を出す) */
  get isResetAvailable(): boolean {
    // コース復帰の直後 (自車が点滅している 3 秒間) は、続けて復帰できない
    return this.phase === 'running' && this.resetTimer < 0 && this.ghostTimeRemaining <= 0 && this.lap.isResetAvailable(this.car);
  }

  /** 現在の周のタイム */
  get currentLapTime(): number {
    return this.lap.currentLapTime;
  }

  /** ゴーストの位置 (表示できるときだけ true) */
  ghostPose(out: Pose): boolean {
    if (!this.ghostPlayer || this.lap.lap === 0) return false;
    return this.ghostPlayer.sample(this.lap.currentLapTime, out);
  }

  get hasGhost(): boolean {
    return this.ghostPlayer !== null;
  }

  step(controls: Controls, dt: number): readonly TimeAttackEvent[] {
    this.events.length = 0;
    const car = this.car;

    // カウントダウン
    if (this.phase === 'countdown') {
      const value = Math.ceil(this.countdownRemaining - 1e-9);
      if (value !== this.lastCountdownValue && value > 0) {
        this.lastCountdownValue = value;
        this.events.push({ type: 'countdown', value });
      }
      this.countdownRemaining -= dt;
      if (this.countdownRemaining <= 0) {
        this.phase = 'running';
        car.controlLocked = false;
        this.events.push({ type: 'go' });
      }
    }

    // コース復帰
    if (controls.resetPressed && this.phase === 'running' && this.resetTimer < 0) {
      if (this.isResetAvailable) {
        this.resetTimer = 0;
        car.controlLocked = true;
        this.events.push({ type: 'resetStarted' });
      } else {
        this.events.push({ type: 'resetRejected' });
      }
    }
    this.updateReset(dt);

    this.drs.update(car, this.lap.projection.s);
    car.update(controls, dt);
    // スピン中は sF が更新されないので、実際の速さを使う
    this.gearbox.update(car.isSpinning ? car.speed : car.sF);
    const lapEvents = this.lap.update(car, dt);
    if (this.resetTimer >= 0 || this.ghostTimeRemaining > 0) this.lap.holdResetConditions();
    for (const e of lapEvents) this.handleLapEvent(e, dt);
    if (this.drs.enabledOnEntry) this.events.push({ type: 'drsEnabled' });
    if (car.drsOpened) this.events.push({ type: 'drsOpened' });
    if (car.drsClosed) this.events.push({ type: 'drsClosed' });
    if (this.recorder.isRecording) this.recorder.record(this.lap.currentLapTime, car.x, car.y, car.heading);
    return this.events;
  }

  private updateReset(dt: number): void {
    const fade = raceRules.resetFadeTime;
    if (this.resetTimer < 0) {
      this.ghostTimeRemaining = Math.max(0, this.ghostTimeRemaining - dt);
      return;
    }
    const before = this.resetTimer;
    this.resetTimer += dt;
    const t = this.resetTimer;
    if (before < fade && t >= fade) {
      // 暗転しきったところで置き直す
      this.lap.resetPose(this.tmpPose);
      this.car.placeAt(this.tmpPose);
      this.car.controlLocked = true;
      this.recorder.cancel();
      for (const e of this.lap.applyReset(this.car)) this.handleLapEvent(e, dt);
      this.events.push({ type: 'resetPlaced' });
    }
    const lockEnd = fade + raceRules.resetLockTime;
    this.screenFade = t < fade ? t / fade : Math.max(0, 1 - (t - fade) / fade);
    this.resetLockRemaining = t < fade ? raceRules.resetLockTime : Math.max(0, lockEnd - t);
    if (t >= lockEnd) {
      this.resetTimer = -1;
      this.screenFade = 0;
      this.resetLockRemaining = 0;
      this.car.controlLocked = false;
      this.ghostTimeRemaining = raceRules.resetGhostTime;
      this.events.push({ type: 'resetFinished' });
    }
  }

  private handleLapEvent(e: LapEvent, dt: number): void {
    this.events.push(e);
    const car = this.car;
    switch (e.type) {
      case 'lapStarted': {
        this.sectorResults.fill('none');
        this.ghostDelta = null;
        const lapTime = this.lap.currentLapTime;
        this.recorder.start(lapTime, dt, car.prevX, car.prevY, car.heading - car.yawRate * dt);
        break;
      }
      case 'sector': {
        const result = this.classifySector(e.index, e.time, e.valid);
        this.sectorResults[e.index] = result;
        this.events.push({ type: 'sectorResult', index: e.index, time: e.time, result });
        break;
      }
      case 'timingLine': {
        if (this.ghostPlayer && e.index > 0) {
          const delta = this.ghostPlayer.deltaAt(e.index, e.lapTime);
          if (delta !== null) {
            this.ghostDelta = delta;
            this.events.push({ type: 'ghostDelta', delta });
          }
        }
        break;
      }
      case 'lapInvalidated':
        this.recorder.cancel();
        break;
      case 'lapCompleted':
        this.completeLap(e.lap, e.time, e.valid, e.sectors, e.splits);
        break;
      default:
        break;
    }
  }

  private classifySector(index: number, time: number, valid: boolean): TimingResult {
    if (!valid) return 'none';
    let result: TimingResult = 'slower';
    const allTime = this.record.bestSectors[index];
    const session = this.sessionBestSectors[index];
    if (session === null || time <= session) {
      this.sessionBestSectors[index] = time;
      result = 'personal';
    }
    if (allTime === null || allTime === undefined || time <= allTime) result = 'overall';
    return result;
  }

  private completeLap(lap: number, time: number, valid: boolean, sectors: readonly number[], splits: readonly number[]): void {
    this.lastLap = time;
    let result: TimingResult = 'none';
    let isNewRecord = false;
    if (valid) {
      result = 'slower';
      if (this.sessionBestLap === null || time <= this.sessionBestLap) {
        this.sessionBestLap = time;
        result = 'personal';
      }
      if (this.record.bestLap === null || time < this.record.bestLap) {
        result = 'overall';
        isNewRecord = true;
      }
    }
    this.lastLapResult = result;

    let recordChanged = false;
    if (valid) {
      // 区間の全期間ベストは、周全体が有効なら周のベストと関係なく更新する
      for (let i = 0; i < 3; i++) {
        const v = sectors[i];
        const best = this.record.bestSectors[i];
        if (Number.isFinite(v) && (best === null || best === undefined || v < best)) {
          this.record.bestSectors[i] = v;
          recordChanged = true;
        }
      }
    }
    if (isNewRecord && this.recorder.isRecording) {
      const ghost = this.recorder.finish(this.track.id, this.track.version, time, splits, sectors);
      this.record.bestLap = time;
      this.record.ghost = ghost;
      this.ghostPlayer = new GhostPlayer(ghost);
      recordChanged = true;
    } else if (isNewRecord) {
      this.record.bestLap = time;
      recordChanged = true;
    }
    this.recorder.cancel();
    this.events.push({ type: 'lapResult', lap, time, result, isNewRecord });
    if (recordChanged) this.events.push({ type: 'recordUpdated', record: cloneRecord(this.record) });
  }
}

function isRecordUsable(record: TimeAttackRecord | null, track: Track): record is TimeAttackRecord {
  return record !== null && record.recordVersion === recordVersionOf(track) && record.trackId === track.id;
}

function cloneRecord(r: TimeAttackRecord): TimeAttackRecord {
  return { recordVersion: r.recordVersion, trackId: r.trackId, bestLap: r.bestLap, bestSectors: r.bestSectors.slice(0, 3), ghost: r.ghost };
}
