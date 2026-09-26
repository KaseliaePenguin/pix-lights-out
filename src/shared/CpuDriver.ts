import type { Car } from './Car';
import type { CpuDifficulty, CpuParams } from './carParams';
import { cpuParams } from './carParams';
import type { Controls } from './controls';
import { approach, clamp } from './math';
import type { RacingLine } from './RacingLine';
import type { Random } from './Random';
import type { Track } from './Track';

/** CPU が周りを見るための情報 (セッションが毎フレーム詰める) */
export interface CpuSurroundings {
  /** 当たる可能性のある他車 (ゴーストの関係の車は含めない)。先頭から othersCount 台だけを見る */
  readonly others: readonly Car[];
  othersCount: number;
  /** 発進してよいか (決勝の消灯後) */
  canDrive: boolean;
  /** 消灯からの経過時間 (反応時間の判定に使う。消灯前は負でよい) */
  timeSinceStart: number;
  /** コース復帰を使うべき状態 (逆走・チェックポイント未通過) */
  wantsReset: boolean;
}

export function createCpuSurroundings(capacity: number): CpuSurroundings & { others: Car[] } {
  return { others: new Array<Car>(capacity), othersCount: 0, canDrive: false, timeSinceStart: -1, wantsReset: false };
}

/**
 * CPU 車の運転 (game-design.md 9 章)。レーシングラインを pure pursuit で追い、目標速度でアクセル・ブレーキを決め、
 * Controls を出す (プレイヤーと同じ物理で走る。ズルはしない)。
 * - 腕前 (skill) は目標速度とブレーキの倍率。個体差 ±0.01
 * - コーナーごとに一定の確率でブレーキ開始が 37.5 px 遅れる (ふくらむ)
 * - 前の遅い車を、空いている側へラインを最大 25 px ずらして抜きにいく (最大 3 秒)
 * - 前の車に近づきすぎたらブレーキ、DRS は使えるならすぐ開く、スタックしたらコース復帰
 * 乱数は渡された Random だけを使う (同じ seed なら同じ走り)。
 */
export class CpuDriver {
  /** 個体差を含めた腕前 */
  readonly skill: number;
  /** スタートの反応時間 (秒) */
  readonly reactionTime: number;
  readonly mistakeRate: number;
  /** この CPU の目標速度 (レーシングラインの各点) */
  readonly speeds: Float64Array;
  /** ラインをずらしている量 (px、右が正。演出・デバッグ用) */
  lineOffset = 0;
  /** 今のコーナーでミスをしている */
  isMistaking = false;
  /** 追い抜きのためにラインをずらしている */
  isOvertaking = false;

  private index = -1;
  private overtakeSide = 0;
  private overtakeTimer = 0;
  private overtakeCooldown = 0;
  private stuckTimer = 0;
  private cornerWindowIndex = -1;
  private readonly mistakeShift: number;
  private readonly cornerWindows: readonly { from: number; to: number }[];

  constructor(
    private readonly line: RacingLine,
    private readonly track: Track,
    difficulty: CpuDifficulty,
    private readonly random: Random,
    tyreGrip: number,
    private readonly params: Readonly<CpuParams> = cpuParams,
  ) {
    const d = params.difficulties[difficulty];
    this.skill = d.skill + random.range(-params.skillSpread, params.skillSpread);
    this.reactionTime = random.range(d.reactionMin, d.reactionMax);
    this.mistakeRate = d.mistakeRate;
    this.speeds = line.computeSpeeds({ skill: this.skill, tyreGrip });
    this.mistakeShift = Math.max(1, Math.round(params.mistakeDelay / line.spacing));
    this.cornerWindows = track.corners.map((c) => ({ from: c.s0 - params.mistakeWindow, to: c.s1 }));
  }

  /** この CPU の速度プロファイルでのラップタイムの目安 (秒) */
  get estimatedLapTime(): number {
    return this.line.lapTimeOf(this.speeds);
  }

  /** 車を置き直したときに呼ぶ */
  resetTracking(): void {
    this.index = -1;
    this.lineOffset = 0;
    this.isOvertaking = false;
    this.overtakeTimer = 0;
    this.stuckTimer = 0;
    this.isMistaking = false;
    this.cornerWindowIndex = -1;
  }

  update(car: Car, env: CpuSurroundings, dt: number, out: Controls): Controls {
    out.steerIsAnalog = true;
    out.drsPressed = false;
    out.resetPressed = false;
    if (!env.canDrive || env.timeSinceStart < this.reactionTime) {
      // 発進前は何もしない (ブレーキを踏み続けると後退に入るため、ブレーキも踏まない)
      out.throttle = 0;
      out.brake = 0;
      out.steerInput = 0;
      return out;
    }
    const line = this.line;
    const p = car.params;
    const n = line.count;
    this.index = line.nearestIndex(car.x, car.y, this.index);
    const v = Math.max(0, car.sF);
    const s = line.trackS[this.index];

    this.updateMistake(s);
    this.updateOvertake(car, env, dt);

    // ステア: 先読み点 (ずらした量を含む) へ向かう円弧の曲率から、必要な旋回速度を出す
    const lookAhead = 50 + v * 0.25;
    const target = (this.index + Math.max(1, Math.round(lookAhead / line.spacing))) % n;
    const offset = this.clampOffset(target, this.lineOffset);
    const th = this.track.headings[this.trackIndexOf(target)];
    const tx = line.xs[target] + Math.cos(th) * offset;
    const ty = line.ys[target] + Math.sin(th) * offset;
    const dx = tx - car.x;
    const dy = ty - car.y;
    const sin = Math.sin(car.heading);
    const cos = Math.cos(car.heading);
    const lateral = dx * cos + dy * sin;
    const forward = dx * sin - dy * cos;
    const alpha = Math.atan2(lateral, forward);
    const dist = Math.max(1, Math.hypot(dx, dy));
    const desiredYaw = ((2 * Math.sin(alpha)) / dist) * Math.max(v, 1);
    const yawLimit = v > 0 ? Math.min(p.yawMaxLow * Math.min(1, v / p.yawRampSpeed), (p.latGrip * p.steerDemand) / v) : p.yawMaxLow;
    out.steerInput = clamp(desiredYaw / Math.max(yawLimit, 1e-3), -1, 1);

    // 速度: 少し先の目標速度に合わせる。ミスのときはブレーキ開始が遅れる (手前の点の速度を使う)
    const speeds = this.speeds;
    const here = this.isMistaking ? (this.index - this.mistakeShift + n) % n : this.index;
    const aheadIndex = (here + Math.max(1, Math.round((v * 0.1) / line.spacing))) % n;
    const targetSpeed = Math.min(speeds[aheadIndex], speeds[here] + 30);
    let throttle = 0;
    let brake = 0;
    if (v < targetSpeed - 1) throttle = 1;
    else if (v > targetSpeed + 3) brake = clamp((v - targetSpeed) / 20, 0, 1);
    if (car.uReq > 1.02) throttle = Math.min(throttle, 0.3);

    // 追突回避
    const avoid = this.avoidBrake(car, env);
    if (avoid > 0) {
      throttle = 0;
      brake = Math.max(brake, avoid);
    }
    out.throttle = throttle;
    out.brake = brake;
    out.drsPressed = car.drsAvailable && !car.drsOpen;

    // スタック・逆走・未通過ならコース復帰 (使えるかどうかはセッションが判断する)
    this.stuckTimer = car.speed < this.params.stuckSpeed ? this.stuckTimer + dt : 0;
    out.resetPressed = this.stuckTimer >= this.params.stuckTime || env.wantsReset;
    return out;
  }

  /** コーナーの手前の範囲に入ったときに 1 回だけ、ミスをするかを抽選する */
  private updateMistake(s: number): void {
    let inside = -1;
    for (let k = 0; k < this.cornerWindows.length; k++) {
      const w = this.cornerWindows[k];
      if (this.track.deltaS(w.from, s) >= 0 && this.track.deltaS(s, w.to) >= 0) {
        inside = k;
        break;
      }
    }
    if (inside !== this.cornerWindowIndex) {
      this.cornerWindowIndex = inside;
      this.isMistaking = inside >= 0 && this.random.chance(this.mistakeRate);
    }
  }

  /** 前の遅い車を見つけたら、空いている側へラインをずらす */
  private updateOvertake(car: Car, env: CpuSurroundings, dt: number): void {
    const cp = this.params;
    this.overtakeCooldown = Math.max(0, this.overtakeCooldown - dt);
    if (this.isOvertaking) {
      this.overtakeTimer -= dt;
      // 並んでいる間はラインを戻さない (横から当てないように)。前にも横にも車がいなくなったら戻す
      const beside = this.findNear(car, env, -car.params.hitLength, cp.overtakeRange, cp.aheadLateral + cp.overtakeOffset * 2);
      if (this.overtakeTimer <= 0 || beside === null) {
        this.isOvertaking = false;
        this.overtakeCooldown = cp.overtakeCooldown;
      }
      return this.shiftLine(dt);
    }
    const ahead = this.findNear(car, env, 0, cp.overtakeRange, cp.aheadLateral);
    if (ahead !== null && this.overtakeCooldown <= 0 && this.closingSpeed(car, ahead) > 0) {
      // 前の車が自分の右にいれば左へ。ずらした先にコースの幅がなければ反対側へ
      const aheadLateral = (ahead.x - car.x) * Math.cos(car.heading) + (ahead.y - car.y) * Math.sin(car.heading);
      let side = aheadLateral >= 0 ? -1 : 1;
      const k = this.index;
      if (Math.abs(this.clampOffset(k, side * cp.overtakeOffset)) < cp.overtakeOffset * 0.5) side = -side;
      this.overtakeSide = side;
      this.overtakeTimer = cp.overtakeTime;
      this.isOvertaking = true;
    }
    this.shiftLine(dt);
  }

  private shiftLine(dt: number): void {
    const cp = this.params;
    const goal = this.isOvertaking ? this.overtakeSide * cp.overtakeOffset : 0;
    this.lineOffset = approach(this.lineOffset, goal, cp.overtakeShiftRate * dt);
  }

  /** 追突しそうならブレーキの量 (0〜1) を返す */
  private avoidBrake(car: Car, env: CpuSurroundings): number {
    const cp = this.params;
    const ahead = this.findNear(car, env, 0, car.params.hitLength + cp.avoidGap + 200, cp.aheadLateral);
    if (ahead === null) return 0;
    const closing = this.closingSpeed(car, ahead);
    if (closing <= 0) return 0;
    const forward = (ahead.x - car.x) * Math.sin(car.heading) - (ahead.y - car.y) * Math.cos(car.heading);
    const gap = Math.max(1, forward - car.params.hitLength);
    if (gap <= cp.avoidGap) return clamp(closing / 50, 0.3, 1);
    // 隙間の中で速度差を消すのに要る減速度が大きければ、早めにブレーキ
    const need = (closing * closing) / (2 * gap);
    const limit = car.params.brakeDecel * cp.avoidDecelRatio;
    return need > limit ? clamp(need / car.params.brakeDecel, 0.3, 1) : 0;
  }

  /** 自分の前方向 minForward〜maxForward、横 maxLateral 以内にいる一番前方向に近い車 */
  private findNear(car: Car, env: CpuSurroundings, minForward: number, maxForward: number, maxLateral: number): Car | null {
    const sin = Math.sin(car.heading);
    const cos = Math.cos(car.heading);
    let best: Car | null = null;
    let bestForward = maxForward;
    for (let i = 0; i < env.othersCount; i++) {
      const o = env.others[i];
      const dx = o.x - car.x;
      const dy = o.y - car.y;
      const forward = dx * sin - dy * cos;
      if (forward <= minForward || forward >= bestForward) continue;
      const lateral = dx * cos + dy * sin;
      if (Math.abs(lateral) > maxLateral) continue;
      best = o;
      bestForward = forward;
    }
    return best;
  }

  /** 自分の前方向で、前の車に近づく速さ (正なら近づいている) */
  private closingSpeed(car: Car, ahead: Car): number {
    const fx = Math.sin(car.heading);
    const fy = -Math.cos(car.heading);
    return (car.vx - ahead.vx) * fx + (car.vy - ahead.vy) * fy;
  }

  /** ラインからずらす量を、コースの幅 (端から 11 px の余裕) の中に収める */
  private clampOffset(k: number, offset: number): number {
    if (offset === 0) return 0;
    const i = this.trackIndexOf(k);
    const half = this.track.widths[i] / 2 - 11;
    const base = this.line.offsets[k];
    return clamp(base + offset, -half, half) - base;
  }

  private trackIndexOf(k: number): number {
    return Math.round(this.line.trackS[k] / this.track.sampleSpacing) % this.track.sampleCount;
  }
}
