import type { Car } from './Car';
import { driftGain } from './Car';
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
  /**
   * ドリフトで曲がるコーナー (中心線上の円弧の範囲と曲がる向き +1 = 右)。空ならドリフトしない (grip だけで走る)。
   * レーシングラインも同じコーナーをドリフトの速度で作っておく (RacingLine の driftCorners)
   */
  driftCorners: readonly { s0: number; s1: number; dir: number }[];
  /** ドリフトに入り始める位置 (円弧の始まりの何 px 手前か) */
  driftEntryLead: number;
}

/** 円弧の終わりから、この距離 (px) を過ぎてもドリフトが続いていたらカウンターを当てる */
const driftExitGrace = 150;

const defaultOptions: LineFollowerOptions = {
  digital: false,
  lookAheadBase: 50,
  lookAheadTime: 0.25,
  driftCorners: [],
  driftEntryLead: 100,
};

/**
 * レーシングラインを追う単純な AI (pure pursuit + 目標速度)。Controls を出力する。
 * ヘッドレスのシミュレーション用。M2 の CPU 車の土台にもなる。
 * ドリフトのコーナーでは、ブレーキ + ハンドルでドリフトに入り、ラインの曲がり具合からドリフト角 (ハンドル) を決め、
 * 出口でカウンターを当てて抜ける (ブーストを出す)。
 */
export class LineFollowerAi {
  private index = -1;
  private readonly opt: LineFollowerOptions;
  /** ドリフトのコーナーごとの、ライン上の最低の目標速度 (ドリフトに入る前にここまで落とす) */
  private readonly driftEntrySpeeds: number[];

  constructor(private readonly line: RacingLine, options: Partial<LineFollowerOptions> = {}) {
    this.opt = { ...defaultOptions, ...options };
    this.driftEntrySpeeds = this.opt.driftCorners.map((c) => {
      let v = Infinity;
      for (let k = 0; k < line.count; k++) if (line.trackS[k] >= c.s0 && line.trackS[k] <= c.s1) v = Math.min(v, line.speeds[k]);
      return Number.isFinite(v) ? v : 0;
    });
  }

  /** 車を置き直したときに呼ぶ */
  resetTracking(): void {
    this.index = -1;
  }

  update(car: Car, out: Controls): Controls {
    const line = this.line;
    const n = line.count;
    this.index = line.nearestIndex(car.x, car.y, this.index);
    const p = car.params;
    const v = Math.max(0, car.isDrifting ? car.speed : car.sF);

    // 先読み点へ向かう円弧の曲率 (pure pursuit)。ドリフト中は進行方向を基準にする
    const lookAhead = this.opt.lookAheadBase + v * this.opt.lookAheadTime;
    const target = (this.index + Math.max(1, Math.round(lookAhead / line.spacing))) % n;
    const dx = line.xs[target] - car.x;
    const dy = line.ys[target] - car.y;
    const base = car.travelHeading;
    const lateral = dx * Math.cos(base) + dy * Math.sin(base);
    const forward = dx * Math.sin(base) - dy * Math.cos(base);
    const alpha = Math.atan2(lateral, forward);
    const dist = Math.max(1, Math.hypot(dx, dy));
    const curvature = (2 * Math.sin(alpha)) / dist;

    // 目標速度: 少し先の目標速度に合わせる
    const aheadIndex = (this.index + Math.max(1, Math.round((v * 0.1) / line.spacing))) % n;
    const targetSpeed = Math.min(line.speeds[aheadIndex], line.speeds[this.index] + 30);
    const s = line.trackS[this.index];

    let steer: number;
    let throttle = 0;
    let brake = 0;
    if (car.isDrifting) {
      // ドリフト中: 必要な曲がり具合から、ドリフト角 (= ハンドル) を逆算する (car-physics.md 7.2・7.3 節)
      // 速すぎるときだけ軽くブレーキ (角度が浅いときに限る。深い角度でブレーキを続けるとスピンするため)
      if (v > targetSpeed + 25 && car.beta < p.driftAngleNeutral + p.driftAngleBrake * 0.5) brake = 0.4;
      const grip = car.grip > 0 ? car.grip : 1;
      const needLat = Math.max(0, curvature * car.driftDir) * v * v;
      const capacity = p.latGrip * grip * driftGain(p, v);
      const betaNeedRaw = (needLat / Math.max(1, capacity)) * p.driftAngleRef;
      const betaNeed = clamp(betaNeedRaw, 0, p.driftAngleIn);
      // アクセルは、曲がる余裕があるときだけ踏む (踏むと速くなって大回りになるため)
      throttle = v < targetSpeed && betaNeedRaw < p.driftAngleIn * 0.85 ? 1 : 0;
      const betaBase = betaNeed - throttle * p.driftAngleThrottle;
      let u: number;
      if (betaBase >= p.driftAngleNeutral) u = (betaBase - p.driftAngleNeutral) / Math.max(1e-6, p.driftAngleIn - p.driftAngleNeutral);
      else u = betaBase / Math.max(1e-6, p.driftAngleNeutral) - 1;
      // 円弧の終わりを十分過ぎても抜けていなければ、カウンターを当てて抜ける
      if (!this.driftCornerAt(s, 0) && !this.driftCornerAt(s - driftExitGrace, 0)) u = -1;
      steer = clamp(u, -1, 1) * car.driftDir;
    } else {
      const desiredYaw = curvature * Math.max(v, 1);
      const yawLimit = v > 0 ? Math.min(p.yawMaxLow * Math.min(1, v / p.yawRampSpeed), (p.latGrip * p.steerDemand) / v) : p.yawMaxLow;
      steer = clamp(desiredYaw / Math.max(yawLimit, 1e-3), -1, 1);
      if (v < targetSpeed - 1) throttle = 1;
      else if (v > targetSpeed + 3) brake = clamp((v - targetSpeed) / 20, 0, 1);
      // グリップの限界を超えているときはアクセルを戻してふくらみを抑える
      if (car.uReq > 1.02) throttle = Math.min(throttle, 0.3);

      const corner = this.driftCornerAt(s, this.opt.driftEntryLead);
      if (corner && v >= p.driftEnterSpeed && v <= corner.entrySpeed + 25) {
        // ドリフトに入る: ブレーキ + コーナーの向きにフルにハンドル
        steer = corner.dir;
        brake = Math.max(brake, p.driftEnterBrake + 0.2);
        throttle = 0;
      } else if (corner && v > corner.entrySpeed + 25) {
        // まだ速い: まっすぐブレーキで落としてから入る
        brake = 1;
        throttle = 0;
        const limit = p.driftEnterSteer - 0.02;
        steer = clamp(steer, -limit, limit);
      } else if (brake >= p.driftEnterBrake) {
        // grip で走るところでは、ブレーキ中にドリフトに入らないようハンドルを浅くする
        const limit = p.driftEnterSteer - 0.02;
        steer = clamp(steer, -limit, limit);
      }
    }

    if (this.opt.digital) {
      out.steerInput = Math.abs(steer) > 0.3 ? Math.sign(steer) : 0;
      out.steerIsAnalog = false;
      out.throttle = throttle > 0 ? 1 : 0;
      out.brake = brake > 0.25 ? 1 : 0;
      // キーボードでは、ドリフトに入る場面以外でブレーキ中は切らない (ブレーキ + ハンドルでドリフトに入ってしまうため)
      if (out.brake > 0 && !car.isDrifting && !this.driftCornerAt(s, this.opt.driftEntryLead)) out.steerInput = 0;
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

  /** s がドリフトのコーナー (円弧の lead px 手前から円弧の終わりまで) の中なら、そのコーナーの向きと入る速度 */
  private driftCornerAt(s: number, lead: number): { dir: number; entrySpeed: number } | null {
    const corners = this.opt.driftCorners;
    for (let i = 0; i < corners.length; i++) {
      const c = corners[i];
      if (s >= c.s0 - lead && s <= c.s1) return { dir: c.dir, entrySpeed: this.driftEntrySpeeds[i] };
    }
    return null;
  }
}
