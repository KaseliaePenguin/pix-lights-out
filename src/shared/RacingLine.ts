import type { CarParams } from './carParams';
import { carParams } from './carParams';
import type { Track } from './Track';

export interface RacingLineOptions {
  /** タイヤのグリップ倍率 (ソフト新品 1.08、基準 1.0) */
  tyreGrip: number;
  /** 目標速度にかける倍率 (CPU の腕前。理想走行は 1.0) */
  skill: number;
  /** DRS 区間で DRS を使う前提で速度を計算するか */
  useDrs: boolean;
  /** コース端から車の中心までの余裕 (px) */
  edgeMargin: number;
  /** 縁石に乗ってよい量 (px) */
  kerbUse: number;
  params: Readonly<CarParams>;
}

const defaultOptions: RacingLineOptions = {
  tyreGrip: 1.0,
  skill: 1.0,
  useDrs: true,
  edgeMargin: 11,
  kerbUse: 4,
  params: carParams,
};

/**
 * レーシングライン (中心線とは別の閉じた折れ線) と各点の目標速度 (game-design.md 9.1 節)。
 * 線の形は「コース幅の中で曲率が最小になる線」を反復計算で求め、速度は
 * コーナーの限界速度・加速・ブレーキの前後 2 回の走査で決める。
 */
export class RacingLine {
  readonly count: number;
  readonly spacing: number;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** 中心線上の位置 (対応するサンプルの s) */
  readonly trackS: Float64Array;
  /** 中心線からの横位置 */
  readonly offsets: Float64Array;
  /** 曲率 (右カーブが正) */
  readonly curvature: Float64Array;
  /** 目標速度 (px/秒) */
  readonly speeds: Float64Array;
  /** 線の上での距離 (累積) */
  readonly distances: Float64Array;
  readonly length: number;
  /** 速度プロファイルから計算したラップタイムの目安 (秒) */
  readonly estimatedLapTime: number;

  constructor(private readonly track: Track, options: Partial<RacingLineOptions> = {}) {
    const opt: RacingLineOptions = { ...defaultOptions, ...options };
    const p = opt.params;
    const step = 2;
    const n = Math.floor(track.sampleCount / step);
    this.count = n;
    this.spacing = track.sampleSpacing * step;
    const cx = new Float64Array(n);
    const cy = new Float64Array(n);
    const nx = new Float64Array(n);
    const ny = new Float64Array(n);
    const lo = new Float64Array(n);
    const hi = new Float64Array(n);
    this.trackS = new Float64Array(n);
    const kerbAt = new Uint8Array(track.sampleCount);
    for (const span of track.kerbSpans) {
      const a = Math.round(span.from / track.sampleSpacing);
      const b = Math.round(span.to / track.sampleSpacing);
      for (let i = a; i <= b; i++) kerbAt[i % track.sampleCount] |= span.side === 'left' ? 1 : 2;
    }
    for (let k = 0; k < n; k++) {
      const i = k * step;
      cx[k] = track.xs[i];
      cy[k] = track.ys[i];
      nx[k] = Math.cos(track.headings[i]);
      ny[k] = Math.sin(track.headings[i]);
      const hw = track.widths[i] / 2 - opt.edgeMargin;
      lo[k] = -hw - (kerbAt[i] & 1 ? opt.kerbUse : 0);
      hi[k] = hw + (kerbAt[i] & 2 ? opt.kerbUse : 0);
      this.trackS[k] = i * track.sampleSpacing;
    }

    // 粗い解像度で大きな形を決めてから、細かい解像度で仕上げる (拡散は長い波長ほど収束が遅いため)
    const d = new Float64Array(n);
    for (const [stride, iterations] of [[8, 400], [4, 400], [2, 400], [1, 400]] as const) {
      smoothOffsets(d, cx, cy, nx, ny, lo, hi, stride, iterations);
    }
    this.offsets = d;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      this.xs[k] = cx[k] + nx[k] * d[k];
      this.ys[k] = cy[k] + ny[k] * d[k];
    }
    this.distances = new Float64Array(n);
    let total = 0;
    for (let k = 0; k < n; k++) {
      this.distances[k] = total;
      const j = (k + 1) % n;
      total += Math.hypot(this.xs[j] - this.xs[k], this.ys[j] - this.ys[k]);
    }
    this.length = total;

    // 曲率 (前後 2 点ずつ離した 3 点の外接円。細かな凹凸を拾わないため)
    this.curvature = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const a = (k - 2 + n) % n;
      const b = (k + 2) % n;
      this.curvature[k] = mengerCurvature(this.xs[a], this.ys[a], this.xs[k], this.ys[k], this.xs[b], this.ys[b]);
    }

    // 速度プロファイル
    const vmax = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const drs = opt.useDrs && this.isInDrs(this.trackS[k]);
      const grip = opt.tyreGrip * (drs ? p.drsGripMul : 1);
      const vTop = p.vBase * (1 + (drs ? p.drsBonus : 0));
      const kap = Math.abs(this.curvature[k]);
      let v = vTop;
      if (kap > 1e-6) {
        v = Math.min(v, Math.sqrt((p.latGrip * Math.min(grip, p.steerDemand)) / kap) * opt.skill);
        v = Math.min(v, p.yawMaxLow / kap);
      }
      vmax[k] = v;
    }
    const speeds = Float64Array.from(vmax);
    for (let pass = 0; pass < 2; pass++) {
      // 加速 (前向き)
      for (let m = 0; m < n * 2; m++) {
        const k = m % n;
        const j = (k + 1) % n;
        const drs = opt.useDrs && this.isInDrs(this.trackS[k]);
        const vEff = p.vBase * (1 + (drs ? p.drsBonus : 0));
        const ratio = speeds[k] / vEff;
        const a = Math.max(0, p.accel0 * (1 - ratio * ratio));
        const ds = this.segmentLength(k);
        speeds[j] = Math.min(speeds[j], Math.sqrt(speeds[k] * speeds[k] + 2 * a * ds));
      }
      // ブレーキ (後ろ向き)。ブレーキ中は横グリップが減るので少し控えめの減速度にする
      for (let m = n * 2; m > 0; m--) {
        const k = m % n;
        const j = (k - 1 + n) % n;
        const b = p.brakeDecel * opt.tyreGrip * 0.9 * opt.skill + p.coastBase;
        const ds = this.segmentLength(j);
        speeds[j] = Math.min(speeds[j], Math.sqrt(speeds[k] * speeds[k] + 2 * b * ds));
      }
    }
    this.speeds = speeds;
    let time = 0;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      time += this.segmentLength(k) / Math.max(1, (speeds[k] + speeds[j]) / 2);
    }
    this.estimatedLapTime = time;
  }

  /** 位置に最も近い線上の点の番号。hint (前回の番号) の近くだけを探す */
  nearestIndex(x: number, y: number, hint: number): number {
    const n = this.count;
    let best = -1;
    let bestD = Infinity;
    const scan = (k: number) => {
      const dx = x - this.xs[k];
      const dy = y - this.ys[k];
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    };
    if (hint >= 0) for (let m = -40; m <= 40; m++) scan((hint + m + n) % n);
    if (best < 0 || bestD > 200 * 200) for (let k = 0; k < n; k++) scan(k);
    return best;
  }

  private segmentLength(k: number): number {
    const j = (k + 1) % this.count;
    return Math.hypot(this.xs[j] - this.xs[k], this.ys[j] - this.ys[k]);
  }

  private isInDrs(s: number): boolean {
    const a = this.track.drsStartS;
    const b = this.track.drsEndS;
    return a <= b ? s >= a && s <= b : s >= a || s <= b;
  }
}

/** 曲率がなめらかに変わるよう各点の横位置を動かす反復 (幅の中に制限する)。stride は何点おきに扱うか */
function smoothOffsets(
  d: Float64Array, cx: Float64Array, cy: Float64Array, nx: Float64Array, ny: Float64Array,
  lo: Float64Array, hi: Float64Array, stride: number, iterations: number,
): void {
  const n = d.length;
  const m = Math.floor(n / stride);
  if (stride > 1) {
    // 粗い点の間を線形補間しておく
    for (let k = 0; k < m; k++) {
      const a = k * stride;
      const b = ((k + 1) % m) * stride;
      for (let q = 1; q < stride; q++) {
        const i = (a + q) % n;
        const t = q / stride;
        d[i] = Math.max(lo[i], Math.min(hi[i], d[a] + (d[b] - d[a]) * t));
      }
    }
  }
  // 各点の曲率が前後の点の曲率の平均になるよう、横位置を動かす (K1999 と同じ考え方)。
  // 実際の位置で曲率を測るので、きついコーナーで点の間隔が不均一になっても正しく働く
  const px = (k: number, off: number) => cx[k] + nx[k] * off;
  const py = (k: number, off: number) => cy[k] + ny[k] * off;
  for (let it = 0; it < iterations; it++) {
    for (let k = 0; k < m; k++) {
      const i = k * stride;
      const a1 = ((k - 1 + m) % m) * stride;
      const b1 = ((k + 1) % m) * stride;
      const a2 = ((k - 2 + m) % m) * stride;
      const b2 = ((k + 2) % m) * stride;
      const ax = px(a1, d[a1]), ay = py(a1, d[a1]);
      const bx = px(b1, d[b1]), by = py(b1, d[b1]);
      const ix = px(i, d[i]), iy = py(i, d[i]);
      const kPrev = mengerCurvature(px(a2, d[a2]), py(a2, d[a2]), ax, ay, ix, iy);
      const kNext = mengerCurvature(ix, iy, bx, by, px(b2, d[b2]), py(b2, d[b2]));
      const lenPrev = Math.hypot(ix - ax, iy - ay);
      const lenNext = Math.hypot(bx - ix, by - iy);
      const target = (lenNext * kPrev + lenPrev * kNext) / Math.max(1e-9, lenPrev + lenNext);
      const k0 = mengerCurvature(ax, ay, ix, iy, bx, by);
      const delta = 0.05;
      const k1 = mengerCurvature(ax, ay, px(i, d[i] + delta), py(i, d[i] + delta), bx, by);
      const slope = (k1 - k0) / delta;
      if (Math.abs(slope) < 1e-12) continue;
      const next = d[i] + (target - k0) / slope;
      d[i] = Math.max(lo[i], Math.min(hi[i], next));
    }
  }
  if (stride > 1) {
    for (let k = 0; k < m; k++) {
      const a = k * stride;
      const b = ((k + 1) % m) * stride;
      for (let q = 1; q < stride; q++) {
        const i = (a + q) % n;
        d[i] = Math.max(lo[i], Math.min(hi[i], d[a] + (d[b] - d[a]) * (q / stride)));
      }
    }
  }
}

function mengerCurvature(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const ab = Math.hypot(bx - ax, by - ay);
  const bc = Math.hypot(cx - bx, cy - by);
  const ca = Math.hypot(ax - cx, ay - cy);
  const denom = ab * bc * ca;
  return denom > 0 ? (2 * cross) / denom : 0;
}
