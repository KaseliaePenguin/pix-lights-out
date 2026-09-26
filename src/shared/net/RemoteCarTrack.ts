import { lerp, lerpAngle } from '../math';
import type { CarNetState } from './stateCodec';

/** 表示・判定に使う他車の姿勢と速度 */
export interface RemotePose {
  x: number;
  y: number;
  heading: number;
  sF: number;
  sR: number;
  steer: number;
  /** この姿勢が表すホスト時刻 (ms) */
  time: number;
  /** 使ったサンプルの周回数・次のチェックポイント (ホストの判定) */
  lap: number;
  checkpoint: number;
}

export function createRemotePose(): RemotePose {
  return { x: 0, y: 0, heading: 0, sF: 0, sR: 0, steer: 0, time: 0, lap: 0, checkpoint: 0 };
}

const capacity = 16;

/**
 * 他車 1 台ぶんの、スナップショットで届いた状態の記録 (network.md「同期方式」)。
 * 表示は約 100ms 過去の 2 点間を補間し (interpolate)、自車の近くでは最新の状態と速度から今の位置を予測する (predict)。
 * 時刻はホスト時刻 (ms、スナップショットの時刻)。毎フレームのオブジェクト生成をしないよう、固定長の配列に持つ
 */
export class RemoteCarTrack {
  private readonly t = new Float64Array(capacity);
  private readonly x = new Float64Array(capacity);
  private readonly y = new Float64Array(capacity);
  private readonly heading = new Float64Array(capacity);
  private readonly sF = new Float64Array(capacity);
  private readonly sR = new Float64Array(capacity);
  private readonly steer = new Float64Array(capacity);
  private readonly lap = new Int32Array(capacity);
  private readonly checkpoint = new Int32Array(capacity);
  /** 最新のサンプルのフラグ */
  isGhost = false;
  isInPit = false;
  isSpinning = false;
  isDrsOpen = false;
  isBraking = false;
  isReversing = false;
  private count = 0;
  private head = -1;

  get hasSample(): boolean {
    return this.count > 0;
  }

  /** 最新のサンプルの時刻 (なければ -Infinity) */
  get latestTime(): number {
    return this.count > 0 ? this.t[this.head] : -Infinity;
  }

  /** スナップショットの 1 台ぶんを加える。時刻が最新以下なら捨てる */
  push(time: number, s: CarNetState): void {
    if (this.count > 0 && time <= this.t[this.head]) return;
    const i = (this.head + 1) % capacity;
    this.head = i;
    if (this.count < capacity) this.count++;
    this.t[i] = time;
    this.x[i] = s.x;
    this.y[i] = s.y;
    this.heading[i] = s.heading;
    this.sF[i] = s.sF;
    this.sR[i] = s.sR;
    this.steer[i] = s.steer;
    this.lap[i] = s.lap;
    this.checkpoint[i] = s.checkpoint;
    this.isGhost = s.isGhost;
    this.isInPit = s.isInPit;
    this.isSpinning = s.isSpinning;
    this.isDrsOpen = s.isDrsOpen;
    this.isBraking = s.isBraking;
    this.isReversing = s.isReversing;
  }

  /**
   * time の姿勢を 2 点間の補間で求める。time が最新より新しければ最新から maxAheadMs まで速度で進め、
   * 最古より古ければ最古のまま。サンプルがなければ false
   */
  interpolate(time: number, maxAheadMs: number, out: RemotePose): boolean {
    if (this.count === 0) return false;
    const newest = this.head;
    if (time >= this.t[newest]) return this.predict(time, maxAheadMs, out);
    // 新しい方から、time をはさむ 2 点を探す
    let b = newest;
    for (let k = 1; k < this.count; k++) {
      const a = (this.head - k + capacity) % capacity;
      if (this.t[a] <= time) {
        const u = (time - this.t[a]) / (this.t[b] - this.t[a]);
        out.x = lerp(this.x[a], this.x[b], u);
        out.y = lerp(this.y[a], this.y[b], u);
        out.heading = lerpAngle(this.heading[a], this.heading[b], u);
        out.sF = lerp(this.sF[a], this.sF[b], u);
        out.sR = lerp(this.sR[a], this.sR[b], u);
        out.steer = lerp(this.steer[a], this.steer[b], u);
        out.time = time;
        out.lap = this.lap[a];
        out.checkpoint = this.checkpoint[a];
        return true;
      }
      b = a;
    }
    this.copy(b, out);
    return true;
  }

  /** 最新の状態から、time まで (maxAheadMs を上限に) 速度で進めた姿勢 */
  predict(time: number, maxAheadMs: number, out: RemotePose): boolean {
    if (this.count === 0) return false;
    const i = this.head;
    this.copy(i, out);
    const ahead = Math.max(0, Math.min(time - this.t[i], maxAheadMs)) / 1000;
    if (ahead > 0) {
      const sin = Math.sin(out.heading);
      const cos = Math.cos(out.heading);
      out.x += (sin * out.sF + cos * out.sR) * ahead;
      out.y += (-cos * out.sF + sin * out.sR) * ahead;
      out.time = this.t[i] + ahead * 1000;
    }
    return true;
  }

  private copy(i: number, out: RemotePose): void {
    out.x = this.x[i];
    out.y = this.y[i];
    out.heading = this.heading[i];
    out.sF = this.sF[i];
    out.sR = this.sR[i];
    out.steer = this.steer[i];
    out.time = this.t[i];
    out.lap = this.lap[i];
    out.checkpoint = this.checkpoint[i];
  }
}
