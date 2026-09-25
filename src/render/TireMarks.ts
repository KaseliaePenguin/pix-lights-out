import type { WorldLayer } from '../core/WorldLayer';
import type { Track } from '../shared/Track';
import { SurfaceCode } from '../shared/Track';

/** 最大の本数 (game-design.md 10.4 節)。超えたら古いものから消す */
const capacity = 2000;
/** この秒数で消える */
const lifeTime = 20;
/** これより古いものは点線にして薄く見せる (半透明を使わないため) */
const fadeStart = 14;
/** 前のフレームの同じ車輪とみなす距離 (px)。左右の車輪の間隔 16 px より小さくする */
const linkDistance = 14;
/** 前の点とつなぐ最大の時間差 (秒) */
const linkTime = 0.1;
const recentCount = 8;
const markColor = '#2a2a33';

/**
 * タイヤ痕 (style-guide.md §5 のレイヤー 10)。車輪の位置を毎フレーム add すると、
 * 直前のフレームの同じ車輪の点と線でつなぎ、2 ドット幅の点列で描く。
 */
export class TireMarks {
  private readonly x0 = new Float32Array(capacity);
  private readonly y0 = new Float32Array(capacity);
  private readonly x1 = new Float32Array(capacity);
  private readonly y1 = new Float32Array(capacity);
  private readonly born = new Float64Array(capacity);
  private head = 0;
  private count = 0;

  private readonly recentX = new Float32Array(recentCount);
  private readonly recentY = new Float32Array(recentCount);
  private readonly recentTime = new Float64Array(recentCount).fill(-Infinity);
  private recentHead = 0;

  constructor(private readonly track: Track) {}

  /** 車輪の位置 (ワールド座標 px) を追加する。タイヤ痕を出す間、毎フレーム車輪ごとに呼ぶ */
  add(x: number, y: number): void {
    // 壁の中 (ワールドの外を含む) には付けない
    if (this.track.surfaceCodeAt(x, y) === SurfaceCode.wall) return;
    const now = nowSeconds();
    // 直前に追加された点のうち、近いもの (= 同じ車輪の前のフレーム) とつなぐ
    let best = -1;
    let bestD = linkDistance * linkDistance;
    for (let i = 0; i < recentCount; i++) {
      if (now - this.recentTime[i] > linkTime) continue;
      const dx = x - this.recentX[i];
      const dy = y - this.recentY[i];
      const d = dx * dx + dy * dy;
      if (d < bestD && d > 0) {
        bestD = d;
        best = i;
      }
    }
    const k = this.head;
    this.x0[k] = best >= 0 ? this.recentX[best] : x;
    this.y0[k] = best >= 0 ? this.recentY[best] : y;
    this.x1[k] = x;
    this.y1[k] = y;
    this.born[k] = now;
    this.head = (this.head + 1) % capacity;
    this.count = Math.min(this.count + 1, capacity);

    this.recentX[this.recentHead] = x;
    this.recentY[this.recentHead] = y;
    this.recentTime[this.recentHead] = now;
    this.recentHead = (this.recentHead + 1) % recentCount;
  }

  /** カメラが写す範囲のタイヤ痕を描く (コースの後、車の前に呼ぶ) */
  render(layer: WorldLayer): void {
    const ctx = layer.ctx;
    const now = nowSeconds();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = markColor;
    for (let n = 0; n < this.count; n++) {
      const k = (this.head - 1 - n + capacity) % capacity;
      const age = now - this.born[k];
      if (age > lifeTime) break;
      if (!layer.isVisible((this.x0[k] + this.x1[k]) / 2, (this.y0[k] + this.y1[k]) / 2, 32)) continue;
      const ax = layer.dotX(this.x0[k]);
      const ay = layer.dotY(this.y0[k]);
      const bx = layer.dotX(this.x1[k]);
      const by = layer.dotY(this.y1[k]);
      const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
      const dashed = age > fadeStart;
      for (let s = 0; s <= steps; s++) {
        const px = steps === 0 ? ax : Math.round(ax + ((bx - ax) * s) / steps);
        const py = steps === 0 ? ay : Math.round(ay + ((by - ay) * s) / steps);
        // 点線はワールドに固定した市松の位置だけ残す (動かしても模様が揺れないように)
        if (dashed && ((px + layer.viewLeft / 2 + py + layer.viewTop / 2) & 3) !== 0) continue;
        ctx.fillRect(px - 1, py - 1, 2, 2);
      }
    }
  }

  /** リスタート時にすべて消す */
  clear(): void {
    this.head = 0;
    this.count = 0;
    this.recentTime.fill(-Infinity);
  }
}

function nowSeconds(): number {
  return performance.now() / 1000;
}
