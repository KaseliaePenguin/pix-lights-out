import type { Car } from './Car';
import type { Controls } from './controls';
import { clamp } from './math';
import type { RacingLine } from './RacingLine';

export interface LineFollowerOptions {
  /**
   * true ならキーボードと同じ 0/1 の入力だけを出す (ステアは車側で平滑化される)。
   * キーボードでのタイムの目安を測るため
   */
  digital: boolean;
  /** 先読み距離 = lookAheadBase + 速度 × lookAheadTime (game-design.md 9.1 節) */
  lookAheadBase: number;
  lookAheadTime: number;
}

const defaultOptions: LineFollowerOptions = { digital: false, lookAheadBase: 50, lookAheadTime: 0.25 };

/**
 * レーシングラインを追う単純な AI (pure pursuit + 目標速度)。Controls を出力する。
 * ヘッドレスのシミュレーション用。M2 の CPU 車の土台にもなる。
 */
export class LineFollowerAi {
  private index = -1;
  private readonly opt: LineFollowerOptions;

  constructor(private readonly line: RacingLine, options: Partial<LineFollowerOptions> = {}) {
    this.opt = { ...defaultOptions, ...options };
  }

  /** 車を置き直したときに呼ぶ */
  resetTracking(): void {
    this.index = -1;
  }

  update(car: Car, out: Controls): Controls {
    const line = this.line;
    const n = line.count;
    this.index = line.nearestIndex(car.x, car.y, this.index);
    const v = Math.max(0, car.sF);
    const p = car.params;

    // ステア: 先読み点へ向かう円弧の曲率から、必要な旋回速度を出す
    const lookAhead = this.opt.lookAheadBase + v * this.opt.lookAheadTime;
    const target = (this.index + Math.max(1, Math.round(lookAhead / line.spacing))) % n;
    const dx = line.xs[target] - car.x;
    const dy = line.ys[target] - car.y;
    const sin = Math.sin(car.heading);
    const cos = Math.cos(car.heading);
    const lateral = dx * cos + dy * sin;
    const forward = dx * sin - dy * cos;
    const alpha = Math.atan2(lateral, forward);
    const dist = Math.max(1, Math.hypot(dx, dy));
    const desiredYaw = (2 * Math.sin(alpha) / dist) * Math.max(v, 1);
    const yawLimit = v > 0 ? Math.min(p.yawMaxLow * Math.min(1, v / p.yawRampSpeed), (p.latGrip * p.steerDemand) / v) : p.yawMaxLow;
    const steer = clamp(desiredYaw / Math.max(yawLimit, 1e-3), -1, 1);

    // 速度: 少し先の目標速度に合わせる
    const aheadIndex = (this.index + Math.max(1, Math.round((v * 0.1) / line.spacing))) % n;
    const targetSpeed = Math.min(line.speeds[aheadIndex], line.speeds[this.index] + 30);
    let throttle = 0;
    let brake = 0;
    if (v < targetSpeed - 1) throttle = 1;
    else if (v > targetSpeed + 3) brake = clamp((v - targetSpeed) / 20, 0, 1);
    // グリップの限界を超えているときはアクセルを戻してふくらみを抑える
    if (car.uReq > 1.02) throttle = Math.min(throttle, 0.3);

    if (this.opt.digital) {
      out.steerInput = Math.abs(steer) > 0.3 ? Math.sign(steer) : 0;
      out.steerIsAnalog = false;
      out.throttle = throttle > 0 ? 1 : 0;
      out.brake = brake > 0.25 ? 1 : 0;
    } else {
      out.steerInput = steer;
      out.steerIsAnalog = true;
      out.throttle = throttle;
      out.brake = brake;
    }
    out.drsPressed = car.drsAvailable && !car.drsOpen;
    out.resetPressed = false;
    return out;
  }
}
