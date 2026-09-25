import type { Track } from '../shared/Track';
import { colors } from './colors';
import { drawPanel } from './panel';

/** ミニマップに描く車 1 台 (ワールド座標 px) */
export interface MinimapCar {
  x: number;
  y: number;
  /** チーム色 (colors.ts の teamColors) */
  color: string;
  /** 自車なら 8×8 + 白の輪郭で、最後に (一番上に) 描く */
  isSelf?: boolean;
  /** ゴースト (シャドウ表示): ink の四角 + チーム色の輪郭で、最初に (一番下に) 描く */
  isGhost?: boolean;
}

// style-guide.md §6: 左下 x12 y440 w148 h148。ここでの 1 ドット = 画面 2 px
const panelX = 12;
const panelY = 440;
const panelDots = 74;
/** 枠 (1 ドット) + 余白 (3 ドット) */
const insetDots = 4;
const mapDots = panelDots - insetDots * 2;

/**
 * ミニマップ (game-design.md 10.1 節、style-guide.md §6)。北が上で固定 (カメラが回っても回さない)。
 * コースの形は生成時に 1 回だけ、中心線から 1 ドット (2 px) の線で小さな Canvas に描いておく。壁は描かない。
 * 毎フレーム draw(ctx, cars) で、枠・コース・車を 800×600 の画面に描く。
 */
export class Minimap {
  private readonly image: HTMLCanvasElement | null;
  /** ワールド px → ミニマップのドット */
  private readonly scale: number;
  private readonly originX: number;
  private readonly originY: number;

  constructor(track: Track) {
    // 中心線が収まる範囲を、縦横比を保って枠の内側の中央に置く
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const extend = (xs: ArrayLike<number>, ys: ArrayLike<number>): void => {
      for (let i = 0; i < xs.length; i++) {
        minX = Math.min(minX, xs[i]);
        maxX = Math.max(maxX, xs[i]);
        minY = Math.min(minY, ys[i]);
        maxY = Math.max(maxY, ys[i]);
      }
    };
    extend(track.xs, track.ys);
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    this.scale = (mapDots - 1) / Math.max(spanX, spanY);
    this.originX = insetDots + Math.floor((mapDots - spanX * this.scale) / 2) - minX * this.scale;
    this.originY = insetDots + Math.floor((mapDots - spanY * this.scale) / 2) - minY * this.scale;
    this.image = this.buildImage(track);
  }

  draw(ctx: CanvasRenderingContext2D, cars: readonly MinimapCar[]): void {
    drawPanel(ctx, panelX, panelY, panelDots * 2, panelDots * 2);
    if (this.image) {
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.image, panelX, panelY, panelDots * 2, panelDots * 2);
      ctx.restore();
    }
    // 重なったとき実体のある車・自車を上にする (style-guide.md §2 の描く順番に合わせる)
    for (const car of cars) if (car.isGhost) this.drawCar(ctx, car);
    for (const car of cars) if (!car.isGhost && !car.isSelf) this.drawCar(ctx, car);
    for (const car of cars) if (!car.isGhost && car.isSelf) this.drawCar(ctx, car);
  }

  private drawCar(ctx: CanvasRenderingContext2D, car: MinimapCar): void {
    // 本体 6×6 (自車 8×8) の外側に 2 px の輪郭。中心をドットの格子に合わせる
    const body = car.isSelf ? 8 : 6;
    const size = body + 4;
    const cx = panelX + this.toDotX(car.x) * 2 + 1;
    const cy = panelY + this.toDotY(car.y) * 2 + 1;
    const x = Math.round((cx - size / 2) / 2) * 2;
    const y = Math.round((cy - size / 2) / 2) * 2;
    let outline: string = colors.ink;
    let fill = car.color;
    if (car.isGhost) {
      outline = car.color;
      fill = colors.ink;
    } else if (car.isSelf) {
      outline = colors.white;
    }
    ctx.fillStyle = outline;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = fill;
    ctx.fillRect(x + 2, y + 2, body, body);
  }

  private toDotX(worldX: number): number {
    return Math.max(insetDots, Math.min(panelDots - insetDots - 1, Math.floor(this.originX + worldX * this.scale)));
  }

  private toDotY(worldY: number): number {
    return Math.max(insetDots, Math.min(panelDots - insetDots - 1, Math.floor(this.originY + worldY * this.scale)));
  }

  /** 1 ドット = 1 px の 74×74 の画像にコースを描く (描画時に 2 倍にする) */
  private buildImage(track: Track): HTMLCanvasElement | null {
    const canvas = document.createElement('canvas');
    canvas.width = panelDots;
    canvas.height = panelDots;
    const c = canvas.getContext('2d');
    if (!c) return null;
    // ピットレーンは描かない。本線との間隔 (約 64 px) がミニマップでは 1 ドットに満たず、本線が太く潰れて見えるため
    this.plotPolyline(c, track.xs, track.ys, colors.overlay);

    // コントロールライン (s = 0): 進行方向に直交する 3 ドットの白い線
    const pose = track.poseAt(0);
    const cx = this.toDotX(pose.x);
    const cy = this.toDotY(pose.y);
    // 向き (0 = 北、時計回り) から、直交する向きを縦か横に丸める
    const isVertical = Math.abs(Math.sin(pose.heading)) > Math.abs(Math.cos(pose.heading));
    c.fillStyle = colors.white;
    for (let k = -1; k <= 1; k++) c.fillRect(isVertical ? cx : cx + k, isVertical ? cy + k : cy, 1, 1);
    return canvas;
  }

  /** 閉じた折れ線を 1 ドット幅で打つ (アンチエイリアスを避けるため、線を引かずにドットを並べる) */
  private plotPolyline(
    c: CanvasRenderingContext2D,
    xs: ArrayLike<number>,
    ys: ArrayLike<number>,
    color: string,
  ): void {
    const n = xs.length;
    if (n < 2) return;
    c.fillStyle = color;
    // 中心線は閉じているので、最後の点から最初の点へもつなぐ
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      let x0 = this.toDotX(xs[i]);
      let y0 = this.toDotY(ys[i]);
      const x1 = this.toDotX(xs[j]);
      const y1 = this.toDotY(ys[j]);
      // Bresenham
      const dx = Math.abs(x1 - x0);
      const dy = -Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1;
      const sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        c.fillRect(x0, y0, 1, 1);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) {
          err += dy;
          x0 += sx;
        }
        if (e2 <= dx) {
          err += dx;
          y0 += sy;
        }
      }
    }
  }
}
