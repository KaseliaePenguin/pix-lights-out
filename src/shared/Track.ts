import type { SurfaceKind } from './carParams';
import { raceRules } from './carParams';
import { segmentIntersection } from './math';
import type { RunoffSpec, TrackData, TrackRef, TurnSegment } from './trackData';

/**
 * 路面コード (判定用グリッドの 1 マス = 2 px = 1 ドット)。値が大きいほど重なったときに優先される。
 * 描画でもこのコードをそのまま使える (1 マス = オフスクリーンの 1 ドット)。
 */
export const SurfaceCode = {
  wall: 0,
  grass: 1,
  gravel: 2,
  pit: 3,
  asphalt: 4,
  line: 5,
  kerbRed: 6,
  kerbWhite: 7,
} as const;
export type SurfaceCode = (typeof SurfaceCode)[keyof typeof SurfaceCode];

const surfaceKindByCode: readonly SurfaceKind[] = ['grass', 'grass', 'gravel', 'pit', 'asphalt', 'asphalt', 'kerb', 'kerb'];

/** チェックポイントなどのゲート (線分)。forward はコースの進行方向 */
export interface Gate {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  /** 中心線上の位置 (px) */
  readonly s: number;
  readonly forwardX: number;
  readonly forwardY: number;
}

export interface Pose {
  x: number;
  y: number;
  heading: number;
}

/** 中心線への射影の結果 */
export interface TrackProjection {
  /** 最も近いサンプルの番号 (次回の hint に使う) */
  index: number;
  /** 中心線上の位置 0〜length */
  s: number;
  /** 横位置 (右が正) */
  lateral: number;
  /** 中心線までの距離 */
  distance: number;
  /** その位置の進行方向 θ */
  heading: number;
}

export function createProjection(): TrackProjection {
  return { index: -1, s: 0, lateral: 0, distance: 0, heading: 0 };
}

/** 壁の判定結果。depth > 0 なら壁にめり込んでいる。normal は壁から走行可能な側へ向く単位ベクトル */
export interface WallContact {
  depth: number;
  normalX: number;
  normalY: number;
}

/** 描画用の縁石の区間 (中心線上の s の範囲と側) */
export interface KerbSpan {
  readonly from: number;
  readonly to: number;
  readonly side: 'left' | 'right';
}

const sampleSpacing = 4;
const gridCell = 2;
const sdfCell = 4;
const sdfBand = 48;
const worldMargin = 240;
/**
 * 中心線に沿ってこれより離れた部分同士だけ、間に壁を残す。ヘアピンの内側 (円弧の前後約 50 px) は
 * 壁を置かずに芝生でつなぎ、エイペックスを攻めたときに壁に当たらないようにする。
 * 400 にするとヘアピンの内側を芝生で横切る近道 (約 200 px) ができるので、300 にしている
 */
const clearanceMinGap = 300;

/**
 * コースデータから、判定・描画に必要なものをすべて作る (DOM に依存しない)。
 * 生成は数十〜数百ミリ秒かかるので、シーンの開始時に 1 回だけ作る。
 */
export class Track {
  readonly id: string;
  readonly name: string;
  /** 1 周の長さ (中心線、px) */
  readonly length: number;
  readonly worldWidth: number;
  readonly worldHeight: number;

  /** 中心線のサンプル (sampleSpacing ごと)。xs/ys/headings/widths は同じ番号で対応する */
  readonly sampleCount: number;
  readonly sampleSpacing: number;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly headings: Float64Array;
  readonly widths: Float64Array;
  /** 左右のランオフの幅 (コース端から壁まで) */
  readonly runoffLeft: Float64Array;
  readonly runoffRight: Float64Array;
  readonly kerbSpans: readonly KerbSpan[];

  /** 路面の判定用グリッド (1 マス 2 px)。値は SurfaceCode */
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly surfaceGrid: Uint8Array;

  /** チェックポイント。0 番がコントロールライン */
  readonly checkpoints: readonly Gate[];
  /** 区間 S1・S2 の終わりのチェックポイント番号 (S3 の終わりは 0 番) */
  readonly sectorCheckpoints: readonly [number, number];
  /** タイミングラインの位置 (中心線上の s)。0 番はコントロールライン */
  readonly timingLines: readonly number[];
  readonly drsDetectionS: number;
  readonly drsStartS: number;
  readonly drsEndS: number;
  /** スターティンググリッド 8 か所 (0 = ポール) */
  readonly gridSlots: readonly Pose[];
  /** 予選・タイムアタックの開始位置 */
  readonly soloStart: Pose;

  /** ピットレーンの経路 (4 px ごと) */
  readonly pitXs: Float64Array;
  readonly pitYs: Float64Array;
  readonly pitLength: number;
  readonly pitWidth: number;
  readonly pitEntryGate: Gate;
  readonly pitExitGate: Gate;
  /** ピットボックス 8 か所 (車番 1〜8 の順) */
  readonly pitBoxes: readonly Pose[];

  readonly referenceLapTime: number | null;
  /** データの中心線が閉じていなかった量 (px)。大きい場合はデータを直す (検証用) */
  readonly closureError: number;

  private readonly segStart = new Map<string, { s: number; length: number }>();
  private readonly sdfWidth: number;
  private readonly sdfHeight: number;
  /** 壁までの符号付き距離 ×8 (正 = 壁の中) */
  private readonly sdf: Int16Array;

  constructor(readonly data: TrackData) {
    this.id = data.id;
    this.name = data.name;
    this.referenceLapTime = data.referenceLapTime;

    // --- 1. 中心線 ---
    const raw = traceCenterline(data);
    this.length = raw.length;
    this.closureError = raw.closureError;
    for (const [id, v] of raw.segStart) this.segStart.set(id, v);
    const n = Math.round(this.length / sampleSpacing);
    this.sampleCount = n;
    this.sampleSpacing = this.length / n;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.headings = new Float64Array(n);
    const pose: Pose = { x: 0, y: 0, heading: 0 };
    for (let i = 0; i < n; i++) {
      raw.poseAt(i * this.sampleSpacing, pose);
      this.xs[i] = pose.x;
      this.ys[i] = pose.y;
      this.headings[i] = pose.heading;
    }

    // --- 2. 幅・ランオフ・縁石 ---
    this.widths = new Float64Array(n);
    const gravelL = new Float64Array(n);
    const gravelR = new Float64Array(n);
    this.runoffLeft = new Float64Array(n);
    this.runoffRight = new Float64Array(n);
    const kerbL = new Uint8Array(n);
    const kerbR = new Uint8Array(n);
    const innerLimitL = new Float64Array(n).fill(Infinity);
    const innerLimitR = new Float64Array(n).fill(Infinity);
    this.buildCrossSection(raw.turns, gravelL, gravelR, kerbL, kerbR, innerLimitL, innerLimitR);
    this.limitRunoffByClearance();
    for (let i = 0; i < n; i++) {
      this.runoffLeft[i] = Math.min(this.runoffLeft[i], innerLimitL[i] - this.widths[i] / 2);
      this.runoffRight[i] = Math.min(this.runoffRight[i], innerLimitR[i] - this.widths[i] / 2);
      gravelL[i] = Math.min(gravelL[i], this.runoffLeft[i]);
      gravelR[i] = Math.min(gravelR[i], this.runoffRight[i]);
    }
    this.kerbSpans = collectKerbSpans(kerbL, kerbR, this.sampleSpacing);

    // --- 3. ピットレーンの経路 ---
    const pit = this.buildPitPath();
    this.pitXs = pit.xs;
    this.pitYs = pit.ys;
    this.pitLength = pit.length;
    this.pitWidth = data.pitLane.width;

    // --- 4. ワールドの大きさを決めて、原点が左上に来るように全体を動かす ---
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const ext = this.widths[i] / 2 + Math.max(this.runoffLeft[i], this.runoffRight[i]);
      minX = Math.min(minX, this.xs[i] - ext);
      maxX = Math.max(maxX, this.xs[i] + ext);
      minY = Math.min(minY, this.ys[i] - ext);
      maxY = Math.max(maxY, this.ys[i] + ext);
    }
    for (let i = 0; i < this.pitXs.length; i++) {
      minX = Math.min(minX, this.pitXs[i] - 100);
      maxX = Math.max(maxX, this.pitXs[i] + 100);
      minY = Math.min(minY, this.pitYs[i] - 100);
      maxY = Math.max(maxY, this.pitYs[i] + 100);
    }
    // 1 ドット (2 px) 単位・芝生の縞 (16 ドット) がずれないよう 32 px 単位でずらす
    const offX = Math.ceil((worldMargin - minX) / 32) * 32;
    const offY = Math.ceil((worldMargin - minY) / 32) * 32;
    for (let i = 0; i < n; i++) {
      this.xs[i] += offX;
      this.ys[i] += offY;
    }
    for (let i = 0; i < this.pitXs.length; i++) {
      this.pitXs[i] += offX;
      this.pitYs[i] += offY;
    }
    this.worldWidth = Math.ceil((maxX + offX + worldMargin) / 32) * 32;
    this.worldHeight = Math.ceil((maxY + offY + worldMargin) / 32) * 32;

    // --- 5. 路面グリッド ---
    this.gridWidth = this.worldWidth / gridCell;
    this.gridHeight = this.worldHeight / gridCell;
    this.surfaceGrid = new Uint8Array(this.gridWidth * this.gridHeight);
    this.rasterizePit(data.pitLane.runoff);
    this.rasterizeTrack(gravelL, gravelR, kerbL, kerbR);
    this.removeWallSlivers();

    // --- 6. 壁までの距離 ---
    this.sdfWidth = Math.ceil(this.worldWidth / sdfCell);
    this.sdfHeight = Math.ceil(this.worldHeight / sdfCell);
    this.sdf = this.buildDistanceField();

    // --- 7. ゲート・区間・DRS・グリッド ---
    const sector1 = this.resolveRef(data.sectorEnds[0]);
    const sector2 = this.resolveRef(data.sectorEnds[1]);
    const narrow = data.narrowGates.map((r) => this.resolveRef(r));
    const gateS = buildCheckpointPositions(this.length, [sector1, sector2, ...narrow], raceRules.checkpointSpacing);
    this.checkpoints = gateS.map((s) => this.makeGate(s, narrow.some((v) => Math.abs(v - s) < 1)));
    this.sectorCheckpoints = [nearestIndex(gateS, sector1), nearestIndex(gateS, sector2)];
    const timing: number[] = [];
    const timingCount = Math.floor(this.length / raceRules.timingLineSpacing);
    for (let k = 0; k < timingCount; k++) timing.push(k * raceRules.timingLineSpacing);
    this.timingLines = timing;
    this.drsDetectionS = this.resolveRef(data.drs.detection);
    this.drsStartS = this.resolveRef(data.drs.start);
    this.drsEndS = this.resolveRef(data.drs.end);

    const slots: Pose[] = [];
    const poleSign = data.gridPoleSide === 'right' ? 1 : -1;
    for (let k = 0; k < 8; k++) {
      const lateral = (k % 2 === 0 ? 1 : -1) * poleSign * 15;
      slots.push(this.poseAt(this.length - (25 + 50 * k), lateral));
    }
    this.gridSlots = slots;
    this.soloStart = this.poseAt(this.length - raceRules.soloStartDistance, 0);

    const pitPts = data.pitLane.points;
    this.pitEntryGate = this.makePitGate(this.pitDistanceNear(pitPts[data.pitLane.entryPoint]));
    this.pitExitGate = this.makePitGate(this.pitDistanceNear(pitPts[data.pitLane.exitPoint]));
    this.pitBoxes = this.buildPitBoxes();
  }

  // ------------------------------------------------------------------
  // 公開 API

  /** TrackRef を中心線上の位置 s (0〜length) にする */
  resolveRef(ref: TrackRef): number {
    const seg = this.segStart.get(ref.seg);
    if (!seg) throw new Error(`Unknown track segment: ${ref.seg}`);
    return wrapS(seg.s + (ref.t ?? 0) * seg.length + (ref.offset ?? 0), this.length);
  }

  /** 中心線上の位置 s から横に lateral (右が正) ずらした位置と進行方向 */
  poseAt(s: number, lateral = 0, out: Pose = { x: 0, y: 0, heading: 0 }): Pose {
    const u = wrapS(s, this.length) / this.sampleSpacing;
    const i0 = Math.floor(u) % this.sampleCount;
    const i1 = (i0 + 1) % this.sampleCount;
    const t = u - Math.floor(u);
    const h0 = this.headings[i0];
    let dh = this.headings[i1] - h0;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const heading = h0 + dh * t;
    out.x = this.xs[i0] + (this.xs[i1] - this.xs[i0]) * t + Math.cos(heading) * lateral;
    out.y = this.ys[i0] + (this.ys[i1] - this.ys[i0]) * t + Math.sin(heading) * lateral;
    out.heading = heading;
    return out;
  }

  /** 中心線の幅 (その位置のコース幅) */
  widthAt(s: number): number {
    return this.widths[Math.round(wrapS(s, this.length) / this.sampleSpacing) % this.sampleCount];
  }

  /**
   * 点を中心線に射影する。hint (前回の index) を渡すと近くだけを探すので速く、
   * ヘアピンの隣の直線のような「近いが別の部分」に飛ばない。
   */
  project(x: number, y: number, hint: number, out: TrackProjection = createProjection()): TrackProjection {
    const n = this.sampleCount;
    let best = -1;
    let bestD = Infinity;
    if (hint >= 0) {
      const searchWindow = 60;
      for (let k = -searchWindow; k <= searchWindow; k++) {
        const i = (hint + k + n) % n;
        const dx = x - this.xs[i];
        const dy = y - this.ys[i];
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best < 0 || bestD > 250 * 250) {
      for (let i = 0; i < n; i++) {
        const dx = x - this.xs[i];
        const dy = y - this.ys[i];
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    // サンプル間の位置を前後の線分への射影で補う
    const h = this.headings[best];
    const fx = Math.sin(h);
    const fy = -Math.cos(h);
    const dx = x - this.xs[best];
    const dy = y - this.ys[best];
    const along = Math.max(-this.sampleSpacing, Math.min(this.sampleSpacing, dx * fx + dy * fy));
    out.index = best;
    out.s = wrapS(best * this.sampleSpacing + along, this.length);
    out.lateral = dx * Math.cos(h) + dy * Math.sin(h);
    out.distance = Math.sqrt(bestD);
    out.heading = h;
    return out;
  }

  /** その位置の路面コード (ワールドの外は壁) */
  surfaceCodeAt(x: number, y: number): SurfaceCode {
    const cx = Math.floor(x / gridCell);
    const cy = Math.floor(y / gridCell);
    if (cx < 0 || cy < 0 || cx >= this.gridWidth || cy >= this.gridHeight) return SurfaceCode.wall;
    return this.surfaceGrid[cy * this.gridWidth + cx] as SurfaceCode;
  }

  /** 物理用の路面の種類。壁の中は芝生として扱う */
  surfaceAt(x: number, y: number): SurfaceKind {
    return surfaceKindByCode[this.surfaceCodeAt(x, y)];
  }

  /** 壁までの符号付き距離 (px)。正なら壁にめり込んでいる */
  wallDistance(x: number, y: number): number {
    const gx = x / sdfCell - 0.5;
    const gy = y / sdfCell - 0.5;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    if (ix < 0 || iy < 0 || ix >= this.sdfWidth - 1 || iy >= this.sdfHeight - 1) return sdfBand;
    const tx = gx - ix;
    const ty = gy - iy;
    const w = this.sdfWidth;
    const i = iy * w + ix;
    const a = this.sdf[i] + (this.sdf[i + 1] - this.sdf[i]) * tx;
    const b = this.sdf[i + w] + (this.sdf[i + w + 1] - this.sdf[i + w]) * tx;
    return (a + (b - a) * ty) / 8;
  }

  /** 壁との接触 (深さと、走行可能な側へ向く法線) */
  wallContact(x: number, y: number, out: WallContact): WallContact {
    const d = this.wallDistance(x, y);
    out.depth = d;
    if (d <= -2) {
      out.normalX = 0;
      out.normalY = 0;
      return out;
    }
    const e = 3;
    const gx = this.wallDistance(x + e, y) - this.wallDistance(x - e, y);
    const gy = this.wallDistance(x, y + e) - this.wallDistance(x, y - e);
    const len = Math.hypot(gx, gy);
    if (len < 1e-6) {
      out.normalX = 0;
      out.normalY = 0;
    } else {
      out.normalX = -gx / len;
      out.normalY = -gy / len;
    }
    return out;
  }

  /** 逆走の判定などに使う、s での進行方向 θ */
  headingAt(s: number): number {
    return this.poseAt(s).heading;
  }

  /** 中心線上の a から b へ進む距離 (-length/2〜length/2) */
  deltaS(a: number, b: number): number {
    let d = b - a;
    if (d > this.length / 2) d -= this.length;
    else if (d < -this.length / 2) d += this.length;
    return d;
  }

  /** ピットレーン上の位置 (経路の始点からの距離) */
  pitPoseAt(distance: number, out: Pose = { x: 0, y: 0, heading: 0 }): Pose {
    const m = this.pitXs.length;
    const u = Math.max(0, Math.min(distance / sampleSpacing, m - 1.0001));
    const i = Math.floor(u);
    const t = u - i;
    out.x = this.pitXs[i] + (this.pitXs[i + 1] - this.pitXs[i]) * t;
    out.y = this.pitYs[i] + (this.pitYs[i + 1] - this.pitYs[i]) * t;
    out.heading = Math.atan2(this.pitXs[i + 1] - this.pitXs[i], -(this.pitYs[i + 1] - this.pitYs[i]));
    return out;
  }

  /** 中心線の左右の端 (白線の外側) の位置。描画用 */
  edgePoint(index: number, side: 'left' | 'right', extra: number, out: Pose): Pose {
    const i = ((index % this.sampleCount) + this.sampleCount) % this.sampleCount;
    const sign = side === 'right' ? 1 : -1;
    const lateral = sign * (this.widths[i] / 2 + extra);
    const h = this.headings[i];
    out.x = this.xs[i] + Math.cos(h) * lateral;
    out.y = this.ys[i] + Math.sin(h) * lateral;
    out.heading = h;
    return out;
  }

  // ------------------------------------------------------------------
  // 生成の内部処理

  private buildCrossSection(
    turns: readonly { seg: TurnSegment; s0: number; s1: number }[],
    gravelL: Float64Array, gravelR: Float64Array,
    kerbL: Uint8Array, kerbR: Uint8Array,
    innerLimitL: Float64Array, innerLimitR: Float64Array,
  ): void {
    const d = this.data;
    const n = this.sampleCount;
    const ds = this.sampleSpacing;
    const baseWidth = new Float64Array(n);
    // セグメントごとの幅
    let s = 0;
    for (const seg of d.segments) {
      const len = seg.kind === 'straight' ? seg.length : Math.abs(seg.angle * Math.PI / 180) * seg.radius;
      const w = seg.width ?? d.defaultWidth;
      for (let i = Math.floor(s / ds); i < Math.min(n, Math.ceil((s + len) / ds)); i++) baseWidth[i] = w;
      s += len;
    }
    // 幅のゾーン
    for (const z of d.widthZones) this.forRange(this.resolveRef(z.from), this.resolveRef(z.to), (i) => (baseWidth[i] = z.width));
    // 急に幅が変わらないよう前後 40 px でならす
    const win = Math.round(40 / ds);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -win; k <= win; k++) sum += baseWidth[(i + k + n) % n];
      this.widths[i] = sum / (win * 2 + 1);
    }

    const left = new Float64Array(n).fill(d.straightRunoff.width);
    const right = new Float64Array(n).fill(d.straightRunoff.width);
    const applySpec = (from: number, to: number, side: 'left' | 'right', spec: RunoffSpec) => {
      const total = side === 'left' ? left : right;
      const gravel = side === 'left' ? gravelL : gravelR;
      this.forRange(from, to, (i) => {
        total[i] = Math.max(total[i], spec.width);
        if (spec.kind === 'gravel') gravel[i] = Math.max(gravel[i], spec.width);
      });
    };
    const setSpec = (from: number, to: number, side: 'left' | 'right', spec: RunoffSpec) => {
      const total = side === 'left' ? left : right;
      const gravel = side === 'left' ? gravelL : gravelR;
      this.forRange(from, to, (i) => {
        total[i] = spec.width;
        gravel[i] = spec.kind === 'gravel' ? spec.width : 0;
      });
    };
    for (const t of turns) {
      const outsideSide = t.seg.angle > 0 ? 'left' : 'right';
      const insideSide = t.seg.angle > 0 ? 'right' : 'left';
      if (t.seg.outside) {
        const o = t.seg.outside;
        applySpec(t.s0 - (o.lead ?? 80), t.s1 + (o.trail ?? 200), outsideSide, o);
      }
      if (t.seg.inside) {
        const o = t.seg.inside;
        applySpec(t.s0 - (o.lead ?? 40), t.s1 + (o.trail ?? 40), insideSide, o);
      }
      if (t.seg.kerbs !== false) {
        this.forRange(t.s0 - d.kerbExtend, t.s1 + d.kerbExtend, (i) => {
          kerbL[i] = 1;
          kerbR[i] = 1;
        });
      }
      // 円弧の内側は中心を越えられない
      const limit = t.seg.radius - 4;
      const inner = insideSide === 'left' ? innerLimitL : innerLimitR;
      this.forRange(t.s0, t.s1, (i) => (inner[i] = Math.min(inner[i], limit)));
    }
    for (const z of d.runoffZones) setSpec(this.resolveRef(z.from), this.resolveRef(z.to), z.side, z.spec);
    // 壁の段差を小さくするため前後 60 px でならす (ならしたあとで砂利は全体の幅を超えない)
    const win2 = Math.round(60 / ds);
    for (let i = 0; i < n; i++) {
      let sl = 0;
      let sr = 0;
      for (let k = -win2; k <= win2; k++) {
        sl += left[(i + k + n) % n];
        sr += right[(i + k + n) % n];
      }
      this.runoffLeft[i] = Math.max(sl / (win2 * 2 + 1), gravelL[i]);
      this.runoffRight[i] = Math.max(sr / (win2 * 2 + 1), gravelR[i]);
    }
  }

  /** 別の部分のコースと近いところは、間に壁が残るようにランオフを狭める */
  private limitRunoffByClearance(): void {
    const n = this.sampleCount;
    const step = 2;
    const minWall = this.data.minWallThickness;
    const limL = new Float64Array(n).fill(Infinity);
    const limR = new Float64Array(n).fill(Infinity);
    for (let i = 0; i < n; i += step) {
      const hi = this.headings[i];
      const rx = Math.cos(hi);
      const ry = Math.sin(hi);
      const fx = Math.sin(hi);
      const fy = -Math.cos(hi);
      for (let j = 0; j < n; j += step) {
        const vx = this.xs[j] - this.xs[i];
        const vy = this.ys[j] - this.ys[i];
        if (vx > 700 || vx < -700 || vy > 700 || vy < -700) continue;
        let dsIdx = Math.abs(i - j);
        dsIdx = Math.min(dsIdx, n - dsIdx);
        if (dsIdx * this.sampleSpacing < clearanceMinGap) continue;
        const lat = vx * rx + vy * ry;
        const along = vx * fx + vy * fy;
        const absLat = Math.abs(lat);
        if (absLat > 700 || Math.abs(along) > absLat * 0.6 + 20) continue;
        const gap = absLat - this.widths[i] / 2 - this.widths[j] / 2;
        const hj = this.headings[j];
        const facingRight = -(vx * Math.cos(hj) + vy * Math.sin(hj)) > 0;
        const rMine = lat > 0 ? this.runoffRight[i] : this.runoffLeft[i];
        const rOther = facingRight ? this.runoffRight[j] : this.runoffLeft[j];
        const available = gap - minWall;
        if (rMine + rOther <= available) continue;
        const allowed = Math.max(4, available * rMine / Math.max(1, rMine + rOther));
        const lim = lat > 0 ? limR : limL;
        for (let k = 0; k < step; k++) lim[(i + k) % n] = Math.min(lim[(i + k) % n], allowed);
      }
    }
    for (let i = 0; i < n; i++) {
      this.runoffLeft[i] = Math.min(this.runoffLeft[i], limL[i]);
      this.runoffRight[i] = Math.min(this.runoffRight[i], limR[i]);
    }
  }

  private forRange(from: number, to: number, fn: (i: number) => void): void {
    const n = this.sampleCount;
    const a = Math.round(from / this.sampleSpacing);
    let b = Math.round(to / this.sampleSpacing);
    if (b < a) b += n;
    for (let k = a; k <= b; k++) fn(((k % n) + n) % n);
  }

  private buildPitPath(): { xs: Float64Array; ys: Float64Array; length: number } {
    const pts = this.data.pitLane.points.map((p) => this.poseAt(this.resolveRef(p.at), p.lateral));
    // Catmull-Rom で細かく分けてから、4 px ごとに取り直す
    const dense: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      const steps = Math.max(4, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        dense.push(catmull(p0.x, p1.x, p2.x, p3.x, t), catmull(p0.y, p1.y, p2.y, p3.y, t));
      }
    }
    const last = pts[pts.length - 1];
    dense.push(last.x, last.y);
    // 折れ線に沿って、ちょうど sampleSpacing ごとの点を取り直す
    const xs: number[] = [dense[0]];
    const ys: number[] = [dense[1]];
    let next = sampleSpacing;
    let walked = 0;
    for (let i = 2; i < dense.length; i += 2) {
      const x0 = dense[i - 2];
      const y0 = dense[i - 1];
      const seg = Math.hypot(dense[i] - x0, dense[i + 1] - y0);
      while (seg > 0 && walked + seg >= next) {
        const t = (next - walked) / seg;
        xs.push(x0 + (dense[i] - x0) * t);
        ys.push(y0 + (dense[i + 1] - y0) * t);
        next += sampleSpacing;
      }
      walked += seg;
    }
    return { xs: Float64Array.from(xs), ys: Float64Array.from(ys), length: (xs.length - 1) * sampleSpacing };
  }

  private rasterizeTrack(gravelL: Float64Array, gravelR: Float64Array, kerbL: Uint8Array, kerbR: Uint8Array): void {
    const n = this.sampleCount;
    const lw = this.data.lineWidth;
    const kw = this.data.kerbWidth;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const hw0 = this.widths[i] / 2;
      const hw1 = this.widths[j] / 2;
      // 外側から順に塗る (優先度で上書きされるので順番は見た目に影響しない)
      this.band(i, j, -(hw0 + this.runoffLeft[i]), -hw0, -(hw1 + this.runoffLeft[j]), -hw1, SurfaceCode.grass);
      this.band(i, j, hw0, hw0 + this.runoffRight[i], hw1, hw1 + this.runoffRight[j], SurfaceCode.grass);
      if (gravelL[i] > 0 || gravelL[j] > 0) this.band(i, j, -(hw0 + gravelL[i]), -hw0, -(hw1 + gravelL[j]), -hw1, SurfaceCode.gravel);
      if (gravelR[i] > 0 || gravelR[j] > 0) this.band(i, j, hw0, hw0 + gravelR[i], hw1, hw1 + gravelR[j], SurfaceCode.gravel);
      this.band(i, j, -hw0, hw0, -hw1, hw1, SurfaceCode.asphalt);
      this.band(i, j, -hw0, -hw0 + lw, -hw1, -hw1 + lw, SurfaceCode.line);
      this.band(i, j, hw0 - lw, hw0, hw1 - lw, hw1, SurfaceCode.line);
      // 縁石は 8 ドット (16 px) ごとに赤と白を交互にする
      const stripe = Math.floor((i * this.sampleSpacing) / 16) % 2 === 0 ? SurfaceCode.kerbRed : SurfaceCode.kerbWhite;
      if (kerbL[i] && kerbL[j]) this.band(i, j, -(hw0 + kw), -hw0, -(hw1 + kw), -hw1, stripe);
      if (kerbR[i] && kerbR[j]) this.band(i, j, hw0, hw0 + kw, hw1, hw1 + kw, stripe);
    }
  }

  private rasterizePit(runoff: number): void {
    const m = this.pitXs.length;
    const hw = this.data.pitLane.width / 2;
    for (let i = 0; i < m - 1; i++) {
      const j = i + 1;
      const h = Math.atan2(this.pitXs[j] - this.pitXs[i], -(this.pitYs[j] - this.pitYs[i]));
      const h2 = j + 1 < m ? Math.atan2(this.pitXs[j + 1] - this.pitXs[j], -(this.pitYs[j + 1] - this.pitYs[j])) : h;
      const r0x = Math.cos(h), r0y = Math.sin(h), r1x = Math.cos(h2), r1y = Math.sin(h2);
      const quad = (a: number, b: number, code: SurfaceCode) => this.fillQuad(
        this.pitXs[i] + r0x * a, this.pitYs[i] + r0y * a,
        this.pitXs[i] + r0x * b, this.pitYs[i] + r0y * b,
        this.pitXs[j] + r1x * b, this.pitYs[j] + r1y * b,
        this.pitXs[j] + r1x * a, this.pitYs[j] + r1y * a,
        code,
      );
      quad(-hw - runoff, hw + runoff, SurfaceCode.grass);
      quad(-hw, hw, SurfaceCode.pit);
    }
  }

  /** サンプル i→j の間の、横位置 [a0,b0]→[a1,b1] の帯を塗る */
  private band(i: number, j: number, a0: number, b0: number, a1: number, b1: number, code: SurfaceCode): void {
    const h0 = this.headings[i];
    const h1 = this.headings[j];
    const r0x = Math.cos(h0), r0y = Math.sin(h0), r1x = Math.cos(h1), r1y = Math.sin(h1);
    this.fillQuad(
      this.xs[i] + r0x * a0, this.ys[i] + r0y * a0,
      this.xs[i] + r0x * b0, this.ys[i] + r0y * b0,
      this.xs[j] + r1x * b1, this.ys[j] + r1y * b1,
      this.xs[j] + r1x * a1, this.ys[j] + r1y * a1,
      code,
    );
  }

  private fillQuad(
    ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, code: SurfaceCode,
  ): void {
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx, dx) / gridCell));
    const maxX = Math.min(this.gridWidth - 1, Math.floor(Math.max(ax, bx, cx, dx) / gridCell));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy, dy) / gridCell));
    const maxY = Math.min(this.gridHeight - 1, Math.floor(Math.max(ay, by, cy, dy) / gridCell));
    const grid = this.surfaceGrid;
    const w = this.gridWidth;
    for (let gy = minY; gy <= maxY; gy++) {
      const py = gy * gridCell + gridCell / 2;
      for (let gx = minX; gx <= maxX; gx++) {
        const px = gx * gridCell + gridCell / 2;
        const c1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        const c2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
        const c3 = (dx - cx) * (py - cy) - (dy - cy) * (px - cx);
        const c4 = (ax - dx) * (py - dy) - (ay - dy) * (px - dx);
        const inside = (c1 >= 0 && c2 >= 0 && c3 >= 0 && c4 >= 0) || (c1 <= 0 && c2 <= 0 && c3 <= 0 && c4 <= 0);
        if (!inside) continue;
        const k = gy * w + gx;
        if (grid[k] < code) grid[k] = code;
      }
    }
  }

  /**
   * 薄い壁 (幅 16 px 以下) と小さな壁の島を芝生にする。ランオフとピットレーンの継ぎ目などにできる
   * 細い隙間は、当たり判定では抜けやすく、見た目にも意図しない壁になるため
   */
  private removeWallSlivers(): void {
    const w = this.gridWidth;
    const h = this.gridHeight;
    const grid = this.surfaceGrid;
    /** 薄い壁とみなす幅 (マス = 2 px 単位の実際の距離) */
    const reach = 8;
    // 各方向の直線上で、壁の連続の長さ (実際の距離) が reach 以下で両側が走行可能なら「薄い壁」。
    // 斜め方向は 1 歩が √2 マスなので、歩数ではなく距離で比べる (歩数で比べると斜めの厚い壁まで消える)
    const thin = new Uint8Array(w * h);
    const scanLine = (x0: number, y0: number, dx: number, dy: number) => {
      const stepLength = Math.hypot(dx, dy);
      let runStart = -1;
      let prevDrivable = false;
      let x = x0;
      let y = y0;
      let k = 0;
      const cells: number[] = [];
      while (x >= 0 && y >= 0 && x < w && y < h) {
        const i = y * w + x;
        const wall = grid[i] === SurfaceCode.wall;
        if (wall) {
          if (runStart < 0) {
            runStart = k;
            cells.length = 0;
          }
          cells.push(i);
        } else {
          if (runStart >= 0 && prevDrivable && cells.length * stepLength <= reach) for (const c of cells) thin[c] = 1;
          runStart = -1;
          prevDrivable = true;
        }
        x += dx;
        y += dy;
        k++;
      }
    };
    for (let y = 0; y < h; y++) scanLine(0, y, 1, 0);
    for (let x = 0; x < w; x++) scanLine(x, 0, 0, 1);
    for (let x = 0; x < w; x++) {
      scanLine(x, 0, 1, 1);
      scanLine(x, 0, -1, 1);
    }
    for (let y = 1; y < h; y++) {
      scanLine(0, y, 1, 1);
      scanLine(w - 1, y, -1, 1);
    }
    const toGrass: number[] = [];
    for (let i = 0; i < w * h; i++) if (thin[i]) toGrass.push(i);
    for (const i of toGrass) grid[i] = SurfaceCode.grass;

    // 小さな壁の島 (外周の壁とつながっていない、面積の小さいもの)
    const seen = new Uint8Array(w * h);
    const stack: number[] = [];
    const component: number[] = [];
    const maxIsland = 1500;
    for (let start = 0; start < w * h; start++) {
      if (seen[start] || grid[start] !== SurfaceCode.wall) continue;
      stack.length = 0;
      component.length = 0;
      stack.push(start);
      seen[start] = 1;
      let touchesBorder = false;
      while (stack.length > 0) {
        const c = stack.pop() as number;
        if (component.length <= maxIsland) component.push(c);
        const cx = c % w;
        const cy = (c - cx) / w;
        if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) touchesBorder = true;
        if (cx > 0) visit(c - 1);
        if (cx < w - 1) visit(c + 1);
        if (cy > 0) visit(c - w);
        if (cy < h - 1) visit(c + w);
      }
      if (!touchesBorder && component.length <= maxIsland) for (const c of component) grid[c] = SurfaceCode.grass;
    }
    function visit(i: number): void {
      if (seen[i] || grid[i] !== SurfaceCode.wall) return;
      seen[i] = 1;
      stack.push(i);
    }
  }

  /** 4 px 単位の粗いグリッドで、壁までの符号付き距離を作る (壁の中が正) */
  private buildDistanceField(): Int16Array {
    const w = this.sdfWidth;
    const h = this.sdfHeight;
    const total = w * h;
    const drivable = new Uint8Array(total);
    const ratio = sdfCell / gridCell;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let count = 0;
        for (let oy = 0; oy < ratio; oy++) {
          for (let ox = 0; ox < ratio; ox++) {
            const gx = x * ratio + ox;
            const gy = y * ratio + oy;
            if (gx < this.gridWidth && gy < this.gridHeight && this.surfaceGrid[gy * this.gridWidth + gx] !== SurfaceCode.wall) count++;
          }
        }
        drivable[y * w + x] = count * 2 >= ratio * ratio ? 1 : 0;
      }
    }
    const out = new Int16Array(total);
    const distToOther = (fromDrivable: number): Float32Array => {
      // fromDrivable 側のマスから見た、反対側のマスまでの距離 (シードを伝える BFS)
      const dist = new Float32Array(total).fill(Infinity);
      const seed = new Int32Array(total).fill(-1);
      const queue = new Int32Array(total);
      let head = 0;
      let tail = 0;
      for (let i = 0; i < total; i++) {
        if (drivable[i] === fromDrivable) continue;
        const x = i % w;
        const y = (i - x) / w;
        // 反対側のマスで、fromDrivable 側に接しているものをシードにする
        let touches = false;
        for (let oy = -1; oy <= 1 && !touches; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (drivable[ny * w + nx] === fromDrivable) {
              touches = true;
              break;
            }
          }
        }
        if (touches) {
          seed[i] = i;
          dist[i] = 0;
          queue[tail++] = i;
        }
      }
      const maxCells = sdfBand / sdfCell + 2;
      while (head < tail) {
        const c = queue[head++];
        const cx = c % w;
        const cy = (c - cx) / w;
        const sd = seed[c];
        const sx = sd % w;
        const sy = (sd - sx) / w;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = cx + ox;
            const ny = cy + oy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (drivable[ni] !== fromDrivable) continue;
            const d = Math.hypot(nx - sx, ny - sy);
            if (d >= dist[ni] || d > maxCells) continue;
            if (dist[ni] === Infinity && tail < total) queue[tail++] = ni;
            dist[ni] = d;
            seed[ni] = sd;
          }
        }
        if (tail >= total && head >= total) break;
      }
      return dist;
    };
    const wallSide = distToOther(0);
    const driveSide = distToOther(1);
    for (let i = 0; i < total; i++) {
      let v: number;
      if (drivable[i]) {
        const d = driveSide[i];
        v = d === Infinity ? -sdfBand : -(d * sdfCell - sdfCell / 2);
      } else {
        const d = wallSide[i];
        v = d === Infinity ? sdfBand : d * sdfCell - sdfCell / 2;
      }
      out[i] = Math.round(Math.max(-sdfBand, Math.min(sdfBand, v)) * 8);
    }
    return out;
  }

  private makeGate(s: number, narrow: boolean): Gate {
    const i = Math.round(s / this.sampleSpacing) % this.sampleCount;
    const hw = this.widths[i] / 2;
    const extra = narrow ? this.data.kerbWidth + 4 : 0;
    let left = narrow ? hw + extra : hw + this.runoffLeft[i] + 2;
    let right = narrow ? hw + extra : hw + this.runoffRight[i] + 2;
    const p = this.poseAt(s);
    const rx = Math.cos(p.heading);
    const ry = Math.sin(p.heading);
    if (!narrow) {
      // ピットレーンがこの位置を横切るなら、ゲートをピットレーンまで伸ばす (ピット内でも通過が数えられる)
      for (const sign of [1, -1]) {
        for (let k = 0; k < this.pitXs.length - 1; k++) {
          const t = segmentIntersection(
            p.x, p.y, p.x + rx * sign * 260, p.y + ry * sign * 260,
            this.pitXs[k], this.pitYs[k], this.pitXs[k + 1], this.pitYs[k + 1],
          );
          if (t < 0) continue;
          const reach = t * 260 + this.data.pitLane.width / 2 + 4;
          if (sign > 0) right = Math.max(right, reach);
          else left = Math.max(left, reach);
          break;
        }
      }
    }
    return {
      ax: p.x - rx * left,
      ay: p.y - ry * left,
      bx: p.x + rx * right,
      by: p.y + ry * right,
      s,
      forwardX: Math.sin(p.heading),
      forwardY: -Math.cos(p.heading),
    };
  }

  private pitDistanceNear(point: { at: TrackRef; lateral: number }): number {
    const target = this.poseAt(this.resolveRef(point.at), point.lateral);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.pitXs.length; i++) {
      const d = Math.hypot(this.pitXs[i] - target.x, this.pitYs[i] - target.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best * sampleSpacing;
  }

  private makePitGate(distance: number): Gate {
    const p = this.pitPoseAt(distance);
    const hw = this.data.pitLane.width / 2 + 4;
    const rx = Math.cos(p.heading);
    const ry = Math.sin(p.heading);
    return {
      ax: p.x - rx * hw,
      ay: p.y - ry * hw,
      bx: p.x + rx * hw,
      by: p.y + ry * hw,
      s: distance,
      forwardX: Math.sin(p.heading),
      forwardY: -Math.cos(p.heading),
    };
  }

  private buildPitBoxes(): Pose[] {
    // コントロールラインの横を中心に、64 px 間隔で 8 つ並べる
    const ctrl = this.poseAt(0);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.pitXs.length; i++) {
      const d = Math.hypot(this.pitXs[i] - ctrl.x, this.pitYs[i] - ctrl.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const center = best * sampleSpacing;
    const boxes: Pose[] = [];
    for (let k = 0; k < 8; k++) boxes.push(this.pitPoseAt(center + (k - 3.5) * 64));
    return boxes;
  }
}

// ----------------------------------------------------------------------

function wrapS(s: number, length: number): number {
  const r = s % length;
  return r < 0 ? r + length : r;
}

function nearestIndex(values: readonly number[], target: number): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (Math.abs(values[i] - target) < Math.abs(values[best] - target)) best = i;
  return best;
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** 必ず置く位置 (区間の境界など) を含め、間隔が spacing 以下になるようにチェックポイントを並べる */
function buildCheckpointPositions(length: number, mandatory: number[], spacing: number): number[] {
  const fixed = [0, ...mandatory].sort((a, b) => a - b);
  const out: number[] = [];
  for (let k = 0; k < fixed.length; k++) {
    const a = fixed[k];
    const b = k + 1 < fixed.length ? fixed[k + 1] : length;
    out.push(a);
    const parts = Math.ceil((b - a) / spacing);
    for (let p = 1; p < parts; p++) out.push(a + ((b - a) * p) / parts);
  }
  return out;
}

function collectKerbSpans(kerbL: Uint8Array, kerbR: Uint8Array, ds: number): KerbSpan[] {
  const spans: KerbSpan[] = [];
  for (const [flags, side] of [[kerbL, 'left'], [kerbR, 'right']] as const) {
    let start = -1;
    for (let i = 0; i <= flags.length; i++) {
      const on = i < flags.length && flags[i] === 1;
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        spans.push({ from: start * ds, to: (i - 1) * ds, side });
        start = -1;
      }
    }
  }
  return spans;
}

interface TracedCenterline {
  length: number;
  closureError: number;
  segStart: Map<string, { s: number; length: number }>;
  turns: { seg: TurnSegment; s0: number; s1: number }[];
  poseAt(s: number, out: Pose): Pose;
}

/**
 * セグメントの並びから中心線を作る。最後の位置・向きが始点と少しずれていても、
 * ずれを全周に比例配分して閉じる (データの丸め誤差を吸収する)。
 */
function traceCenterline(data: TrackData): TracedCenterline {
  interface Piece { s0: number; len: number; x: number; y: number; h: number; curvature: number }
  const pieces: Piece[] = [];
  const segStart = new Map<string, { s: number; length: number }>();
  const turns: { seg: TurnSegment; s0: number; s1: number }[] = [];
  let x = 0;
  let y = 0;
  let h = data.startHeading;
  let s = 0;
  for (const seg of data.segments) {
    if (seg.kind === 'straight') {
      pieces.push({ s0: s, len: seg.length, x, y, h, curvature: 0 });
      if (seg.id) segStart.set(seg.id, { s, length: seg.length });
      x += Math.sin(h) * seg.length;
      y -= Math.cos(h) * seg.length;
      s += seg.length;
    } else {
      const a = (seg.angle * Math.PI) / 180;
      const len = Math.abs(a) * seg.radius;
      const k = Math.sign(a) / seg.radius;
      pieces.push({ s0: s, len, x, y, h, curvature: k });
      if (seg.id) segStart.set(seg.id, { s, length: len });
      turns.push({ seg, s0: s, s1: s + len });
      const end = piecePose(pieces[pieces.length - 1], len);
      x = end.x;
      y = end.y;
      h = end.h;
      s += len;
    }
  }
  const length = s;
  const errX = x;
  const errY = y;
  const turned = h - data.startHeading;
  const errH = turned - Math.PI * 2 * Math.round(turned / (Math.PI * 2));
  return {
    length,
    closureError: Math.hypot(errX, errY),
    segStart,
    turns,
    poseAt(sq: number, out: Pose): Pose {
      let lo = 0;
      let hi = pieces.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (pieces[mid].s0 <= sq) lo = mid;
        else hi = mid - 1;
      }
      const p = piecePose(pieces[lo], sq - pieces[lo].s0);
      const f = sq / length;
      out.x = p.x - errX * f;
      out.y = p.y - errY * f;
      out.heading = p.h - errH * f;
      return out;
    },
  };
}

function piecePose(p: { x: number; y: number; h: number; curvature: number }, d: number): { x: number; y: number; h: number } {
  if (p.curvature === 0) return { x: p.x + Math.sin(p.h) * d, y: p.y - Math.cos(p.h) * d, h: p.h };
  const h1 = p.h + p.curvature * d;
  const r = 1 / p.curvature;
  // 向き θ の前方 (sin, -cos) を積分した形
  return { x: p.x + r * (Math.cos(p.h) - Math.cos(h1)), y: p.y + r * (Math.sin(p.h) - Math.sin(h1)), h: h1 };
}
