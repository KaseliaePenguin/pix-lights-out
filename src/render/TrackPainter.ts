import type { Pose, Track } from '../shared/Track';
import { SurfaceCode } from '../shared/Track';

/**
 * コースの静的な見た目 (style-guide.md §5 のレイヤー 1〜9) を、ドット単位の RGBA に塗る。
 * DOM に依存しないので、ブラウザ (TrackRenderer) と node (確認用の画像の書き出し) の両方で使う。
 * 座標はすべて「ワールドのドット」(ワールド px ÷ 2)。路面グリッドの 1 マスがちょうど 1 ドット。
 */

/** 32×32 などの路面テクスチャの画素 (RGBA) */
export interface TexturePixels {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface TrackTextures {
  asphalt: TexturePixels | null;
  grass: TexturePixels | null;
  gravel: TexturePixels | null;
  /** なければ asphalt で代用する */
  pit: TexturePixels | null;
}

type Rgb = readonly [number, number, number];

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** style-guide.md §4 のパレット */
const color = {
  ink: hex('#11111b'),
  surface: hex('#313244'),
  white: hex('#ffffff'),
  asphalt: hex('#3c3c46'),
  asphaltLight: hex('#4b4b57'),
  grass: hex('#3e7a33'),
  grassDark: hex('#2e5e2a'),
  gravel: hex('#b8a37a'),
  red: hex('#e8322b'),
  yellow: hex('#ffd60a'),
} as const;

/** ピットボックスの枠の色 (車番 1〜8 のチーム色) */
const teamColors: readonly Rgb[] = ['#e8322b', '#ff8c1a', '#ffd60a', '#0e9f6e', '#22d3ee', '#3b82f6', '#f048b8', '#ffffff'].map(hex);

/** 重ね描きする図形 (向き付きの長方形)。中心・大きさはドット単位 */
interface Stamp {
  cx: number;
  cy: number;
  /** 長方形の前方向 (中心線の進行方向) */
  fx: number;
  fy: number;
  /** 横方向 (右) の半幅と、前後方向の半長 */
  halfW: number;
  halfL: number;
  kind: 'solid' | 'checker';
  rgb: Rgb;
  /** true ならアスファルト (白線を含む) の上だけに塗る */
  onRoadOnly: boolean;
}

export class TrackPainter {
  private readonly stamps: Stamp[] = [];
  readonly worldDotsWidth: number;
  readonly worldDotsHeight: number;

  constructor(private readonly track: Track, private readonly textures: TrackTextures) {
    this.worldDotsWidth = track.gridWidth;
    this.worldDotsHeight = track.gridHeight;
    this.buildStamps();
  }

  /** ワールドのドット座標 (x0, y0) から w×h の範囲を out (RGBA、w×h×4) に塗る */
  paint(x0: number, y0: number, w: number, h: number, out: Uint8ClampedArray | Uint8Array): void {
    const grid = this.track.surfaceGrid;
    const gw = this.track.gridWidth;
    const gh = this.track.gridHeight;
    const code = (x: number, y: number): number => (x < 0 || y < 0 || x >= gw || y >= gh ? SurfaceCode.wall : grid[y * gw + x]);

    for (let j = 0; j < h; j++) {
      const y = y0 + j;
      for (let i = 0; i < w; i++) {
        const x = x0 + i;
        const c = code(x, y);
        let rgb: Rgb | null = null;
        let tex: TexturePixels | null = null;
        switch (c) {
          case SurfaceCode.wall:
            rgb = this.barrierColor(x, y, code);
            if (!rgb) tex = this.textures.grass;
            break;
          case SurfaceCode.grass:
            tex = this.textures.grass;
            break;
          case SurfaceCode.gravel:
            tex = this.textures.gravel;
            break;
          case SurfaceCode.pit:
            // ピットレーンとコース・芝生との境界に 2 ドットの白線
            rgb = isNearOther(x, y, code, SurfaceCode.pit, 2) ? color.white : null;
            if (!rgb) tex = this.textures.pit ?? this.textures.asphalt;
            break;
          case SurfaceCode.asphalt:
            tex = this.textures.asphalt;
            break;
          case SurfaceCode.line:
            rgb = color.white;
            break;
          default:
            // 縁石: コース外 (芝生・砂利・壁) に接する外周に 1 ドットの輪郭
            rgb = isKerbOutline(x, y, code) ? color.ink : c === SurfaceCode.kerbRed ? color.red : color.white;
            break;
        }
        const k = (j * w + i) * 4;
        if (rgb) {
          out[k] = rgb[0];
          out[k + 1] = rgb[1];
          out[k + 2] = rgb[2];
        } else if (tex) {
          const tx = ((x % tex.width) + tex.width) % tex.width;
          const ty = ((y % tex.height) + tex.height) % tex.height;
          const t = (ty * tex.width + tx) * 4;
          out[k] = tex.data[t];
          out[k + 1] = tex.data[t + 1];
          out[k + 2] = tex.data[t + 2];
        } else {
          const f = fallbackColor(c, y);
          out[k] = f[0];
          out[k + 1] = f[1];
          out[k + 2] = f[2];
        }
        out[k + 3] = 255;
      }
    }
    for (const s of this.stamps) this.applyStamp(s, x0, y0, w, h, out, code);
  }

  /** 壁 (タイヤバリア): 走行できる場所から 2 ドット以内を黒と濃い灰の帯にする。それより外は芝生 */
  private barrierColor(x: number, y: number, code: (x: number, y: number) => number): Rgb | null {
    let near = 99;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (code(x + dx, y + dy) !== SurfaceCode.wall) near = Math.min(near, Math.max(Math.abs(dx), Math.abs(dy)));
      }
    }
    if (near === 1) return color.ink;
    if (near === 2) return color.surface;
    return null;
  }

  private buildStamps(): void {
    const t = this.track;
    const toDot = (p: Pose) => ({ x: p.x / 2, y: p.y / 2, fx: Math.sin(p.heading), fy: -Math.cos(p.heading) });

    // 6. スタート / フィニッシュライン: 幅 4 ドット、2×2 ドットの市松 (コースの上だけ)
    const ctrl = toDot(t.poseAt(0));
    const halfTrack = t.widthAt(0) / 4 + 1;
    this.stamps.push({ cx: ctrl.x, cy: ctrl.y, fx: ctrl.fx, fy: ctrl.fy, halfW: halfTrack, halfL: 2, kind: 'checker', rgb: color.white, onRoadOnly: true });

    // 7. スターティンググリッド: 幅 14 ドットのコの字 (線幅 2 ドット)。前の横棒は車の鼻先の 1 ドット前
    for (const slot of t.gridSlots) {
      const p = toDot(slot);
      const bar = { along: 12, half: 7 };
      // 横棒
      this.pushLocal(p, 0, bar.along, 7, 1, color.white);
      // 左右の縦棒 (横棒の両端から後ろへ 8 ドット)
      this.pushLocal(p, -(bar.half - 1), bar.along - 4, 1, 4, color.white);
      this.pushLocal(p, bar.half - 1, bar.along - 4, 1, 4, color.white);
    }

    // 8. ピットレーンの速度制限区間の始点・終点: 幅 2 ドットの黄色の線
    for (const g of [t.pitEntryGate, t.pitExitGate]) {
      const cx = (g.ax + g.bx) / 4;
      const cy = (g.ay + g.by) / 4;
      const halfW = Math.hypot(g.bx - g.ax, g.by - g.ay) / 4 - 2;
      this.stamps.push({ cx, cy, fx: g.forwardX, fy: g.forwardY, halfW, halfL: 1, kind: 'solid', rgb: color.yellow, onRoadOnly: false });
    }

    // 9. ピットボックス: 16×28 ドットの枠 (線幅 2 ドット、チーム色)。ピットレーンのコースから遠い側に置く
    t.pitBoxes.forEach((box, i) => {
      const p = toDot(box);
      const side = t.pitWidth / 4 - 8 - 1;
      const rgb = teamColors[i];
      this.pushLocal(p, side, 13, 8, 1, rgb);
      this.pushLocal(p, side, -13, 8, 1, rgb);
      this.pushLocal(p, side - 7, 0, 1, 14, rgb);
      this.pushLocal(p, side + 7, 0, 1, 14, rgb);
    });
  }

  /** 基準の向き付きの点から、右に lateral・前に along ずらした長方形を追加する */
  private pushLocal(p: { x: number; y: number; fx: number; fy: number }, lateral: number, along: number, halfW: number, halfL: number, rgb: Rgb): void {
    const rx = -p.fy;
    const ry = p.fx;
    this.stamps.push({
      cx: p.x + rx * lateral + p.fx * along,
      cy: p.y + ry * lateral + p.fy * along,
      fx: p.fx,
      fy: p.fy,
      halfW,
      halfL,
      kind: 'solid',
      rgb,
      onRoadOnly: false,
    });
  }

  private applyStamp(
    s: Stamp, x0: number, y0: number, w: number, h: number, out: Uint8ClampedArray | Uint8Array,
    code: (x: number, y: number) => number,
  ): void {
    const r = Math.abs(s.halfW) + Math.abs(s.halfL) + 1;
    const minX = Math.max(x0, Math.floor(s.cx - r));
    const maxX = Math.min(x0 + w - 1, Math.ceil(s.cx + r));
    const minY = Math.max(y0, Math.floor(s.cy - r));
    const maxY = Math.min(y0 + h - 1, Math.ceil(s.cy + r));
    if (minX > maxX || minY > maxY) return;
    const rx = -s.fy;
    const ry = s.fx;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        // ドットの中心で判定する
        const dx = x + 0.5 - s.cx;
        const dy = y + 0.5 - s.cy;
        const u = dx * rx + dy * ry;
        const v = dx * s.fx + dy * s.fy;
        if (u < -s.halfW || u >= s.halfW || v < -s.halfL || v >= s.halfL) continue;
        if (s.onRoadOnly) {
          const c = code(x, y);
          if (c !== SurfaceCode.asphalt && c !== SurfaceCode.line) continue;
        }
        let rgb = s.rgb;
        if (s.kind === 'checker') {
          const cu = Math.floor((u + s.halfW) / 2);
          const cv = Math.floor((v + s.halfL) / 2);
          rgb = (cu + cv) % 2 === 0 ? color.white : color.ink;
        }
        const k = ((y - y0) * w + (x - x0)) * 4;
        out[k] = rgb[0];
        out[k + 1] = rgb[1];
        out[k + 2] = rgb[2];
        out[k + 3] = 255;
      }
    }
  }
}

function isNearOther(x: number, y: number, code: (x: number, y: number) => number, self: number, reach: number): boolean {
  for (let d = 1; d <= reach; d++) {
    if (code(x + d, y) !== self || code(x - d, y) !== self || code(x, y + d) !== self || code(x, y - d) !== self) return true;
  }
  return false;
}

function isKerbOutline(x: number, y: number, code: (x: number, y: number) => number): boolean {
  const off = (c: number) => c === SurfaceCode.grass || c === SurfaceCode.gravel || c === SurfaceCode.wall;
  return off(code(x + 1, y)) || off(code(x - 1, y)) || off(code(x, y + 1)) || off(code(x, y - 1));
}

/** テクスチャ画像がないときの色。芝生はワールド座標に固定した 16 ドット幅の縞 */
function fallbackColor(c: number, y: number): Rgb {
  switch (c) {
    case SurfaceCode.gravel:
      return color.gravel;
    case SurfaceCode.pit:
      return color.asphaltLight;
    case SurfaceCode.asphalt:
      return color.asphalt;
    default:
      return Math.floor(y / 16) % 2 === 0 ? color.grass : color.grassDark;
  }
}
