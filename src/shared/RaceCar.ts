import { Car } from './Car';
import type { CarParams } from './carParams';
import type { Controls } from './controls';
import { createControls } from './controls';
import type { CpuDriver } from './CpuDriver';
import { DrsController } from './DrsController';
import { LapTracker } from './LapTracker';
import type { RaceGap } from './raceGap';
import type { TimingResult } from './TimeAttackSession';
import type { Pose, Track } from './Track';
import { VirtualGearbox } from './VirtualGearbox';

/**
 * racing = 走行中、finished = ゴールした、unclassified = 先頭のゴールから 30 秒たってもゴールしていない (未完走)、
 * retired = リタイア (DNF)
 */
export type RaceCarStatus = 'racing' | 'finished' | 'unclassified' | 'retired';

export const gapLeader: RaceGap = { kind: 'leader' };
export const gapPit: RaceGap = { kind: 'pit' };
export const gapOut: RaceGap = { kind: 'out' };
export const gapNone: RaceGap = { kind: 'none' };

/**
 * 決勝に出る車 1 台分の状態 (RaceSession が作って更新する)。シーンは読むだけにする。
 * 物理は car、周回は lap、DRS は drs、仮想ギアは gearbox。
 */
export class RaceCar {
  readonly car: Car;
  readonly lap: LapTracker;
  readonly drs: DrsController;
  readonly gearbox = new VirtualGearbox();
  /** このフレームに車へ渡した入力 */
  readonly controls: Controls = createControls();

  status: RaceCarStatus = 'racing';
  /** 今の順位 (1 から) */
  position = 0;
  /** 進行距離 P (px)。コントロールラインを 1 周目の開始として、グリッドでは負。ゴール・未完走・リタイアで止まる */
  distance = 0;
  /** 終えた周回数 */
  lapsCompleted = 0;
  /** ゴールタイム (消灯からの秒、ペナルティを含まない)。ゴールしていなければ null */
  finishTime: number | null = null;
  /** ペナルティ (秒)。フライングで +3 */
  penalty = 0;
  isJumpStart = false;
  /** 反応時間 (消灯からアクセルを踏むまで)。まだなら null */
  reactionTime: number | null = null;

  /** タイム (決勝のセッション内) */
  bestLap: number | null = null;
  lastLap: number | null = null;
  lastLapResult: TimingResult = 'none';
  /** 現在の周の区間の色 (未通過は none) */
  readonly sectorResults: TimingResult[] = ['none', 'none', 'none'];
  readonly bestSectors: (number | null)[] = [null, null, null];
  /** 終えた周のタイム (1 周目は消灯から) */
  readonly lapTimes: number[] = [];
  /** 現在の周のタイム (1 周目は消灯から) */
  currentLapTime = 0;

  /** 前の車との差・先頭との差・後ろの車との差 (後ろがいなければ null) */
  gapToAhead: RaceGap = gapNone;
  gapToLeader: RaceGap = gapNone;
  gapToBehind: RaceGap | null = null;
  /** 周回遅れにする車が後ろに来ている (BLUE FLAG) */
  isBlueFlag = false;
  /** 決勝の DRS: この周の区間で使える (検知ラインで条件成立) */
  isDrsEligible = false;

  /** コース復帰: 画面の暗さ 0〜1、操作不能の残り秒、復帰後のゴースト (点滅) の残り秒 */
  screenFade = 0;
  resetLockRemaining = 0;
  ghostTimeRemaining = 0;
  /** ピット出口を出たあとのゴーストの残り秒 */
  pitGhostRemaining = 0;

  // --- RaceSession だけが使う ---
  /** @internal コース復帰の手順の経過 (使っていなければ -1) */
  resetTimer = -1;
  /** @internal 今の周・区間の開始時刻 (セッションの時刻) */
  lapStartAt = 0;
  sectorStartAt = 0;
  /** @internal タイミングラインの通過時刻 [周 × 本数 + 番号] (セッションの時刻、未通過は NaN) */
  readonly timingTimes: Float64Array;
  /** @internal 最後に通過したタイミングラインの添字 (まだなければ -1) */
  lastTimingKey = -1;
  /** @internal DRS 検知ラインを最後に通過した時刻 */
  lastDrsDetectionAt = -Infinity;
  drsDetectionCrossedAt = -1;
  wasInDrsZone = false;
  prevS = 0;
  /** @internal ゴールした順 (0 から、ゴールしていなければ -1) */
  finishOrder = -1;
  /** @internal 消灯前にアクセル・ブレーキを踏んだ (フライングの判定) */
  hasGridInput = false;
  /** @internal 結果を推定で決めた */
  isEstimated = false;

  constructor(
    readonly carNumber: number,
    readonly isPlayer: boolean,
    /** RaceSession.cars での番号 */
    readonly index: number,
    readonly gridSlot: number,
    readonly gridPose: Readonly<Pose>,
    readonly driver: CpuDriver | null,
    track: Track,
    totalLaps: number,
    params: Readonly<CarParams>,
  ) {
    this.car = new Car(track, params);
    this.car.compound = 'soft';
    this.car.wear = 0;
    this.lap = new LapTracker(track);
    this.drs = new DrsController(track, 'race');
    this.timingTimes = new Float64Array((totalLaps + 2) * track.timingLines.length).fill(NaN);
  }

  /** 周回表示用の周 (1〜totalLaps) */
  displayLap(totalLaps: number): number {
    return Math.min(Math.max(this.lap.lap, 1), totalLaps);
  }

  /**
   * 他車とすり抜ける状態 (全車に対してゴースト): コース復帰の手順中と直後 3 秒、ピットレーン内と出口後 1 秒、
   * ゴール後、未完走、リタイア。周回遅れの組み合わせは RaceSession.isGhostPair で別に判定する
   */
  get isGhost(): boolean {
    return (
      this.status !== 'racing' ||
      this.resetTimer >= 0 ||
      this.ghostTimeRemaining > 0 ||
      this.lap.isInPitLane ||
      this.pitGhostRemaining > 0
    );
  }

  /** 点滅させるゴースト (コース復帰直後・ピット出口後、game-design.md 7.10 節) */
  get isGhostBlinking(): boolean {
    return this.status === 'racing' && (this.ghostTimeRemaining > 0 || this.pitGhostRemaining > 0);
  }
}
