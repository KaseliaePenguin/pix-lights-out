import type { Car } from './Car';
import { raceRules } from './carParams';
import { segmentIntersection, wrapAngle } from './math';
import type { Gate, Pose, Track } from './Track';
import { createProjection, SurfaceCode } from './Track';

/** ピットレーンにいる状態を、コース上 (コース端 + この幅以内) に戻ってこの秒数たったら解除する */
const pitLeaveMargin = 8;
const pitLeaveTime = 0.5;

export type LapInvalidReason = 'missedCheckpoint' | 'reset' | 'pitLane';

export type LapEvent =
  /** コントロールラインを通過して周回が始まった (lap は 1 から) */
  | { type: 'lapStarted'; lap: number; time: number }
  /** 周回が終わった。time はラップタイム、at は通過の時刻 (LapTracker.time の基準) */
  | { type: 'lapCompleted'; lap: number; time: number; at: number; valid: boolean; sectors: readonly number[]; splits: readonly number[] }
  /** 区間 (0〜2) を通過した。time は区間タイム、at は通過の時刻 */
  | { type: 'sector'; lap: number; index: number; time: number; at: number; valid: boolean }
  /** タイミングライン (250 px ごと) を通過した。lapTime はその時点の周回タイム、at は通過の時刻 */
  | { type: 'timingLine'; lap: number; index: number; lapTime: number; at: number }
  | { type: 'checkpointMissed' }
  | { type: 'checkpointRecovered' }
  | { type: 'lapInvalidated'; reason: LapInvalidReason }
  | { type: 'wrongWayStarted' }
  | { type: 'wrongWayEnded' }
  | { type: 'pitEntry' }
  | { type: 'pitExit' };

/**
 * 周回・チェックポイント・区間・タイミングラインの判定と、逆走・コース復帰の条件 (game-design.md 7.4・7.11・10.3 節)。
 * 車 1 台に 1 つ作り、車の update の直後に update を呼ぶ。
 */
export class LapTracker {
  /** 周回番号。0 = まだコントロールラインを通っていない (アウトラップ・スタート前) */
  lap = 0;
  /** 次に通るべきチェックポイントの番号 */
  nextCheckpoint = 0;
  /** この周が有効か (チェックポイント未通過・コース復帰・ピットで無効) */
  lapValid = true;
  /** チェックポイント未通過状態 */
  isCheckpointMissed = false;
  /** 逆走警告が出ている */
  isWrongWay = false;
  /** ピットレーン内 */
  isInPitLane = false;
  /** 経過時間 (update の dt の合計、秒) */
  time = 0;
  /** 現在の周の区間タイム (未通過は null) */
  readonly sectorTimes: (number | null)[] = [null, null, null];
  /** 現在の周のタイミングラインの通過タイム (未通過は NaN) */
  readonly splits: number[];
  /** 最後に正常に走っていた中心線上の位置 */
  lastValidS = 0;
  /** 中心線への射影 (毎フレーム更新) */
  readonly projection = createProjection();
  /** 次のタイミングラインの番号 */
  nextTimingLine = 0;

  private lapStartTime = 0;
  private sectorStartTime = 0;
  private sectorIndex = 0;
  private wrongWayTimer = 0;
  private slowTimer = 0;
  private offTrackTimer = 0;
  private pitLeaveTimer = 0;
  private isPitReentryAllowed = true;
  private prevS = 0;
  private readonly events: LapEvent[] = [];

  constructor(private readonly track: Track) {
    this.splits = new Array<number>(track.timingLines.length).fill(NaN);
  }

  /** スタート位置に置いた直後に呼ぶ。次のチェックポイントなどを位置から決め直す */
  resetForStart(car: Car): void {
    this.lap = 0;
    this.time = 0;
    this.lapValid = true;
    this.isCheckpointMissed = false;
    this.isWrongWay = false;
    this.isInPitLane = false;
    this.isPitReentryAllowed = true;
    this.wrongWayTimer = 0;
    this.slowTimer = 0;
    this.offTrackTimer = 0;
    this.sectorTimes.fill(null);
    this.splits.fill(NaN);
    this.projection.index = -1;
    this.track.project(car.x, car.y, -1, this.projection);
    this.prevS = this.projection.s;
    this.lastValidS = this.projection.s;
    this.nextCheckpoint = this.firstCheckpointAhead(this.projection.s);
    this.nextTimingLine = this.track.timingLines.length;
  }

  /** 現在の周の経過タイム (周回が始まっていなければ 0) */
  get currentLapTime(): number {
    return this.lap > 0 ? this.time - this.lapStartTime : 0;
  }

  /** 1 周の中での進行距離 (チェックポイントの間に制限したもの。順位の計算用) */
  get progressS(): number {
    const cps = this.track.checkpoints;
    const n = cps.length;
    const prev = cps[(this.nextCheckpoint - 1 + n) % n].s;
    const next = cps[this.nextCheckpoint].s;
    const s = this.projection.s;
    const span = this.track.deltaS(prev, next) || this.track.length / n;
    const d = Math.max(0, Math.min(span, this.track.deltaS(prev, s)));
    return (prev + d) % this.track.length;
  }

  /** コース復帰の条件を満たしているか (スピン中・ピット内は不可。スタート前かどうかは呼び出し側で判断する) */
  isResetAvailable(car: Car): boolean {
    if (car.isSpinning || this.isInPitLane) return false;
    return (
      this.slowTimer >= raceRules.resetSlowTime ||
      this.offTrackTimer >= raceRules.resetOffTrackTime ||
      this.isWrongWay ||
      this.isCheckpointMissed
    );
  }

  /**
   * コース復帰の条件のうち、時間で数えるもの (低速 1.0 秒・4 輪コース外 1.5 秒) を 0 に戻す。
   * コース復帰の手順中と、復帰後の禁止期間 (3 秒) の間は毎フレーム呼び、禁止期間が終わってから数え始める (7.11 節)
   */
  holdResetConditions(): void {
    this.slowTimer = 0;
    this.offTrackTimer = 0;
  }

  /** コース復帰の置き直し先 (最後に正常に走っていた地点から中心線沿いに 150 px 手前) */
  resetPose(out?: Pose): Pose {
    return this.track.poseAt(this.lastValidS - raceRules.resetBackDistance, 0, out);
  }

  /** 車を置き直したあとに呼ぶ。この周は無効になる */
  applyReset(car: Car): LapEvent[] {
    this.events.length = 0;
    this.projection.index = -1;
    this.track.project(car.x, car.y, -1, this.projection);
    this.prevS = this.projection.s;
    if (this.isCheckpointMissed) {
      this.isCheckpointMissed = false;
      this.events.push({ type: 'checkpointRecovered' });
    }
    if (this.isWrongWay) {
      this.isWrongWay = false;
      this.events.push({ type: 'wrongWayEnded' });
    }
    this.wrongWayTimer = 0;
    this.slowTimer = 0;
    this.offTrackTimer = 0;
    this.invalidate('reset');
    // 次のタイミングラインは置き直した位置の先のものにする
    this.nextTimingLine = this.lap > 0 ? this.firstTimingLineAhead(this.projection.s) : this.track.timingLines.length;
    return this.events;
  }

  /** 車の update の直後に呼ぶ。このフレームに起きたことを返す (配列は次の呼び出しで使い回す) */
  update(car: Car, dt: number): readonly LapEvent[] {
    this.events.length = 0;
    const t0 = this.time;
    this.time += dt;
    const track = this.track;
    track.project(car.x, car.y, this.projection.index, this.projection);
    const s = this.projection.s;

    // 1. チェックポイント
    const cps = track.checkpoints;
    const n = cps.length;
    const next = cps[this.nextCheckpoint];
    const f = crossForward(car, next);
    if (f >= 0) {
      this.passCheckpoint(t0 + f * dt);
    } else {
      // 次のゲートより先 (半周以内) のゲートを前向きに通ったときだけ「飛ばした」とみなす。
      // 後ろのゲート (逆走から戻ったとき・コース復帰で手前に置き直されたとき) は数えない
      for (let k = 1; k <= Math.floor(n / 2); k++) {
        const j = (this.nextCheckpoint + k) % n;
        if (crossForward(car, cps[j]) >= 0 && !this.isCheckpointMissed) {
          this.isCheckpointMissed = true;
          this.events.push({ type: 'checkpointMissed' });
          this.invalidate('missedCheckpoint');
          break;
        }
      }
    }

    // 2. タイミングライン
    if (this.lap > 0 && this.nextTimingLine < track.timingLines.length) {
      const lineS = track.timingLines[this.nextTimingLine];
      const moved = track.deltaS(this.prevS, s);
      const before = track.deltaS(this.prevS, lineS);
      if (moved > 0 && moved < 60 && before > 0 && before <= moved) {
        const cross = t0 + (before / moved) * dt;
        const lapTime = cross - this.lapStartTime;
        this.splits[this.nextTimingLine] = lapTime;
        this.events.push({ type: 'timingLine', lap: this.lap, index: this.nextTimingLine, lapTime, at: cross });
        this.nextTimingLine++;
      }
    }

    // 3. ピットレーン: ゲートではなく位置で判定する。コースのランオフにかかったピットの路面に
    //    はみ出しただけでは入ったことにせず、ランオフより外のピットの路面に出たら「進入」とする
    const i = this.projection.index;
    const lateral = this.projection.lateral;
    const halfWidth = track.widths[i] / 2;
    const ownArea = halfWidth + (lateral > 0 ? track.runoffRight[i] : track.runoffLeft[i]);
    if (!this.isInPitLane) {
      // 出たあとは、一度コースに戻るまで入り直さない (出口ラインの先もしばらくピットの路面が続くため)
      if (!this.isPitReentryAllowed && Math.abs(lateral) < halfWidth + pitLeaveMargin) this.isPitReentryAllowed = true;
      if (this.isPitReentryAllowed && track.surfaceCodeAt(car.x, car.y) === SurfaceCode.pit && Math.abs(lateral) > ownArea + 2) {
        this.isInPitLane = true;
        this.pitLeaveTimer = 0;
        this.events.push({ type: 'pitEntry' });
        this.invalidate('pitLane');
      }
    } else if (crossForward(car, track.pitExitGate) >= 0) {
      this.isInPitLane = false;
      this.isPitReentryAllowed = false;
      this.events.push({ type: 'pitExit' });
    } else {
      // 出口ラインを通らずにコースへ戻った (入口で引き返したなど) ときも、しばらくコース上にいれば解除する
      this.pitLeaveTimer = Math.abs(lateral) < halfWidth + pitLeaveMargin ? this.pitLeaveTimer + dt : 0;
      if (this.pitLeaveTimer >= pitLeaveTime) {
        this.isInPitLane = false;
        this.events.push({ type: 'pitExit' });
      }
    }

    // 4. 逆走 (10.3 節)
    const angle = Math.abs(wrapAngle(car.heading - this.projection.heading));
    if (angle > raceRules.wrongWayAngle && car.sF >= raceRules.wrongWaySpeed && !car.isSpinning) {
      this.wrongWayTimer += dt;
      if (!this.isWrongWay && this.wrongWayTimer >= raceRules.wrongWayTime) {
        this.isWrongWay = true;
        this.events.push({ type: 'wrongWayStarted' });
      }
    } else {
      this.wrongWayTimer = 0;
      // 前を向き直すか止まれば警告を消す
      if (this.isWrongWay && (angle < Math.PI / 2 || car.speed < raceRules.wrongWaySpeed)) {
        this.isWrongWay = false;
        this.events.push({ type: 'wrongWayEnded' });
      }
    }

    // 5. コース復帰の条件
    this.slowTimer = car.speed < raceRules.resetSlowSpeed ? this.slowTimer + dt : 0;
    this.offTrackTimer = car.wheelsOffTrack >= 4 ? this.offTrackTimer + dt : 0;

    // 6. 最後に正常に走っていた地点
    if (car.wheelsOffTrack < 4 && !this.isCheckpointMissed && !this.isWrongWay && !this.isInPitLane && this.isBetweenCheckpoints(s)) {
      this.lastValidS = s;
    }
    this.prevS = s;
    return this.events;
  }

  private passCheckpoint(crossTime: number): void {
    const track = this.track;
    const n = track.checkpoints.length;
    const index = this.nextCheckpoint;
    if (this.isCheckpointMissed) {
      this.isCheckpointMissed = false;
      this.events.push({ type: 'checkpointRecovered' });
    }
    if (index === 0) {
      if (this.lap > 0) {
        const lapTime = crossTime - this.lapStartTime;
        const sectorTime = crossTime - this.sectorStartTime;
        this.sectorTimes[2] = sectorTime;
        this.events.push({ type: 'sector', lap: this.lap, index: 2, time: sectorTime, at: crossTime, valid: this.lapValid });
        this.events.push({
          type: 'lapCompleted',
          lap: this.lap,
          time: lapTime,
          at: crossTime,
          valid: this.lapValid,
          sectors: this.sectorTimes.map((v) => v ?? NaN),
          splits: this.splits.slice(),
        });
      }
      this.lap++;
      this.lapStartTime = crossTime;
      this.sectorStartTime = crossTime;
      this.sectorIndex = 0;
      // ピットレーン内でコントロールラインを通った場合は、新しい周も無効のまま
      this.lapValid = !this.isInPitLane;
      this.sectorTimes.fill(null);
      this.splits.fill(NaN);
      this.splits[0] = 0;
      this.nextTimingLine = 1;
      this.events.push({ type: 'lapStarted', lap: this.lap, time: crossTime });
    } else if (this.lap > 0 && this.sectorIndex < 2 && index === track.sectorCheckpoints[this.sectorIndex]) {
      const sectorTime = crossTime - this.sectorStartTime;
      this.sectorTimes[this.sectorIndex] = sectorTime;
      this.events.push({ type: 'sector', lap: this.lap, index: this.sectorIndex, time: sectorTime, at: crossTime, valid: this.lapValid });
      this.sectorStartTime = crossTime;
      this.sectorIndex++;
    }
    this.nextCheckpoint = (index + 1) % n;
  }

  private invalidate(reason: LapInvalidReason): void {
    if (!this.lapValid || this.lap === 0) return;
    this.lapValid = false;
    this.events.push({ type: 'lapInvalidated', reason });
  }

  /** s が「直前のチェックポイント〜次のチェックポイント」の間にあるか (前後に少し余裕を持たせる) */
  private isBetweenCheckpoints(s: number): boolean {
    const cps = this.track.checkpoints;
    const n = cps.length;
    const prev = cps[(this.nextCheckpoint - 1 + n) % n].s;
    const next = cps[this.nextCheckpoint].s;
    return this.track.deltaS(prev, s) >= -raceRules.resetBackDistance && this.track.deltaS(s, next) >= -20;
  }

  private firstCheckpointAhead(s: number): number {
    const cps = this.track.checkpoints;
    for (let i = 0; i < cps.length; i++) if (cps[i].s > s) return i;
    return 0;
  }

  private firstTimingLineAhead(s: number): number {
    const lines = this.track.timingLines;
    for (let i = 1; i < lines.length; i++) if (lines[i] > s) return i;
    return lines.length;
  }
}

/** 車がこのフレームにゲートを前向きに通過したら、通過の位置 (0〜1) を返す。しなければ -1 */
function crossForward(car: Car, gate: Gate): number {
  const mx = car.x - car.prevX;
  const my = car.y - car.prevY;
  if (mx * gate.forwardX + my * gate.forwardY <= 0) return -1;
  return segmentIntersection(car.prevX, car.prevY, car.x, car.y, gate.ax, gate.ay, gate.bx, gate.by);
}
