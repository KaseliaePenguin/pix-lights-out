import type { Pose, Track } from '../shared/Track';
import { createProjection, SurfaceCode } from '../shared/Track';

/**
 * コースの静的な見た目 (style-guide.md §5 のレイヤー 1〜9) を、ドット単位の RGBA に塗る。
 * DOM に依存しないので、ブラウザ (TrackRenderer) と node (確認用の画像の書き出し) の両方で使う。
 * 座標はすべて「ワールドのドット」(ワールド px ÷ 2)。路面グリッドの 1 マスがちょうど 1 ドット。
 */

/** 32×32 などの路面テクスチャ・フォント画像の画素 (RGBA) */
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
  /** ui-font-5x7.png (ピットボックスの車番に使う)。なければ内蔵の数字で描く */
  font: TexturePixels | null;
}

type Rgb = readonly [number, number, number];

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** style-guide.md §4 のパレット */
const color = {
  ink: hex('#11111b'),
  base: hex('#1e1e2e'),
  overlay: hex('#585b70'),
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

/** タイヤバリアの帯の幅 (ドット)。これより外の壁は #1e1e2e の単色 */
const barrierWidth = 4;
/** 縁石のブロックの長さ (中心線に沿ったワールド px。8 ドット) */
const kerbBlockLength = 16;

/** フォント画像の並び (src/ui/BitmapFont.ts と同じ: 16 文字 × 行、セル 6×8、字形 5×7、0x20 から) */
const fontCols = 16;
const fontCellW = 6;
const fontCellH = 8;
const glyphW = 5;
const glyphH = 7;
/** フォント画像がないときの数字 1〜8 (5×7) */
const builtinDigits: Readonly<Record<string, readonly string[]>> = {
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
};

/** 重ね描きする図形 (向き付きの長方形)。中心・大きさはドット単位 */
interface Stamp {
  cx: number;
  cy: number;
  /** 長方形の前方向 */
  fx: number;
  fy: number;
  /** 横方向 (右) の半幅と、前後方向の半長 */
  halfW: number;
  halfL: number;
  kind: 'solid' | 'checker';
  rgb: Rgb;
  /** 塗ってよい路面コード (null ならどこでも) */
  onlyOn: readonly number[] | null;
}

/** 回転しない 1 ビットの画像 (車番の文字など) */
interface Glyph {
  x: number;
  y: number;
  width: number;
  height: number;
  bits: Uint8Array;
  rgb: Rgb;
}

export class TrackPainter {
  private readonly stamps: Stamp[] = [];
  private readonly glyphs: Glyph[] = [];
  private readonly projection = createProjection();
  /** 16×16 ドットの区画ごとの、中心線への射影の手がかり (塗る順番によらず同じ色になるように固定する) */
  private readonly blockHints = new Map<number, number>();
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
    const barrier = this.barrierDistances(x0, y0, w, h, code);

    for (let j = 0; j < h; j++) {
      const y = y0 + j;
      for (let i = 0; i < w; i++) {
        const x = x0 + i;
        const c = code(x, y);
        let rgb: Rgb | null = null;
        let tex: TexturePixels | null = null;
        switch (c) {
          case SurfaceCode.wall:
            // 2b. タイヤバリア (4 ドット、ワールドに固定した 2×2 の市松) / 1b. 壁の外 (単色)
            rgb = barrier[j * w + i] <= barrierWidth ? (((x >> 1) + (y >> 1)) % 2 === 0 ? color.ink : color.overlay) : color.base;
            break;
          case SurfaceCode.grass:
          case SurfaceCode.gravel:
            // 縁石の外周の 1 ドットの輪郭は、コース外側のマスに描く (縁石は幅 4 ドットいっぱいに塗るため)
            if (isNextToKerb(x, y, code)) rgb = color.ink;
            else tex = c === SurfaceCode.grass ? this.textures.grass : this.textures.gravel;
            break;
          case SurfaceCode.pit:
            // ピットレーンとコース・芝生との境界に 2 ドットの白線
            if (isWithin(x, y, code, 2, (v) => v !== SurfaceCode.pit)) rgb = color.white;
            else tex = this.textures.pit ?? this.textures.asphalt;
            break;
          case SurfaceCode.asphalt:
            tex = this.textures.asphalt;
            break;
          case SurfaceCode.line:
            rgb = color.white;
            break;
          default:
            rgb = this.kerbColor(x, y);
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
    for (const g of this.glyphs) applyGlyph(g, x0, y0, w, h, out);
  }

  /**
   * 範囲内の各マスについて、走れる場所 (壁以外) までのチェビシェフ距離 (barrierWidth + 1 で打ち切り)。
   * 横方向の距離を先に求め、縦方向に 9 行分をまとめる 2 段階で計算する
   */
  private barrierDistances(x0: number, y0: number, w: number, h: number, code: (x: number, y: number) => number): Uint8Array {
    const m = barrierWidth;
    const cap = m + 1;
    const rw = w + m * 2;
    const rh = h + m * 2;
    const rowDist = new Uint8Array(rw * rh);
    for (let j = 0; j < rh; j++) {
      const y = y0 - m + j;
      let d = cap;
      for (let i = 0; i < rw; i++) {
        d = code(x0 - m + i, y) !== SurfaceCode.wall ? 0 : Math.min(cap, d + 1);
        rowDist[j * rw + i] = d;
      }
      d = cap;
      for (let i = rw - 1; i >= 0; i--) {
        const k = j * rw + i;
        d = rowDist[k] === 0 ? 0 : Math.min(cap, d + 1);
        if (d < rowDist[k]) rowDist[k] = d;
      }
    }
    const out = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        let best = cap;
        for (let dy = -m; dy <= m && best > Math.abs(dy); dy++) {
          const v = Math.max(Math.abs(dy), rowDist[(j + m + dy) * rw + (i + m)]);
          if (v < best) best = v;
        }
        out[j * w + i] = best;
      }
    }
    return out;
  }

  /** 縁石の色: 中心線に沿った長さ 8 ドットごとに赤と白を交互にする (縁石の幅いっぱいに同じ色) */
  private kerbColor(x: number, y: number): Rgb {
    const key = (y >> 4) * 65536 + (x >> 4);
    let hint = this.blockHints.get(key);
    if (hint === undefined) {
      hint = this.track.project((x >> 4) * 32 + 16, (y >> 4) * 32 + 16, -1, this.projection).index;
      this.blockHints.set(key, hint);
    }
    const p = this.track.project(x * 2 + 1, y * 2 + 1, hint, this.projection);
    return Math.floor(p.s / kerbBlockLength) % 2 === 0 ? color.red : color.white;
  }

  private buildStamps(): void {
    const t = this.track;
    const toDot = (p: Pose) => ({ x: p.x / 2, y: p.y / 2, fx: Math.sin(p.heading), fy: -Math.cos(p.heading) });
    const road = [SurfaceCode.asphalt, SurfaceCode.line];

    // 6. スタート / フィニッシュライン: 幅 4 ドット、2×2 ドットの市松 (コースの上だけ)
    const ctrl = toDot(t.poseAt(0));
    this.stamps.push({ cx: ctrl.x, cy: ctrl.y, fx: ctrl.fx, fy: ctrl.fy, halfW: t.widthAt(0) / 4 + 1, halfL: 2, kind: 'checker', rgb: color.white, onlyOn: road });

    // 7. スターティンググリッド: 幅 14 ドットのコの字 (線幅 2 ドット)。前の横棒は車の鼻先の 1 ドット前
    for (const slot of t.gridSlots) {
      const p = toDot(slot);
      this.pushLocal(p, 0, 12, 7, 1, color.white);
      this.pushLocal(p, -6, 8, 1, 4, color.white);
      this.pushLocal(p, 6, 8, 1, 4, color.white);
    }

    // 8. ピットレーンの速度制限区間の始点・終点: 幅 2 ドットの黄色の線。ピットレーンの進行方向に直角
    const pitHalf = t.pitWidth / 4;
    for (const gate of [t.pitEntryGate, t.pitExitGate]) {
      const p = this.pitDirectionAt(gate.s);
      this.stamps.push({ cx: p.x, cy: p.y, fx: p.fx, fy: p.fy, halfW: pitHalf, halfL: 1, kind: 'solid', rgb: color.yellow, onlyOn: [SurfaceCode.pit] });
    }

    // 9. ピットボックス: 16×28 ドットの枠 (線幅 2 ドット、チーム色)。ピットレーンのコースから遠い側に置き、
    //    外側の白線 (2 ドット) に重ならないようにする。枠の手前 (走行側) に車番をフォント 2 倍で書く
    const boxCenter = pitHalf - 2 - 8;
    t.pitBoxes.forEach((box, i) => {
      const p = toDot(box);
      const rgb = teamColors[i];
      this.pushLocal(p, boxCenter, 13, 8, 1, rgb);
      this.pushLocal(p, boxCenter, -13, 8, 1, rgb);
      this.pushLocal(p, boxCenter - 7, 0, 1, 14, rgb);
      this.pushLocal(p, boxCenter + 7, 0, 1, 14, rgb);
      const lateral = boxCenter - 8 - 1 - glyphW;
      const rx = -p.fy;
      const ry = p.fx;
      const glyph = this.makeDigit(String(i + 1), p.x + rx * lateral, p.y + ry * lateral, color.white);
      if (glyph) this.glyphs.push(glyph);
    });
  }

  /** ピットレーンの経路上の距離 distance での位置と進行方向 (前後 40 px の点から向きを求め、曲線でもぶれないようにする) */
  private pitDirectionAt(distance: number): { x: number; y: number; fx: number; fy: number } {
    const t = this.track;
    const p = t.pitPoseAt(distance);
    const a = t.pitPoseAt(distance - 40);
    const b = t.pitPoseAt(distance + 40);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: p.x / 2, y: p.y / 2, fx: (b.x - a.x) / len, fy: (b.y - a.y) / len };
  }

  /** 車番の文字 (フォント 2 倍 = 10×14 ドット、回転しない)。中心をドット座標 (cx, cy) に置く */
  private makeDigit(text: string, cx: number, cy: number, rgb: Rgb): Glyph | null {
    const pattern = this.glyphPattern(text);
    if (!pattern) return null;
    const scale = 2;
    const width = glyphW * scale;
    const height = glyphH * scale;
    const bits = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bits[y * width + x] = pattern[Math.floor(y / scale)][Math.floor(x / scale)];
    return { x: Math.round(cx - width / 2), y: Math.round(cy - height / 2), width, height, bits, rgb };
  }

  /** 5×7 の字形 (1 = 塗る)。フォント画像があればそこから読み、なければ内蔵の数字を使う */
  private glyphPattern(ch: string): number[][] | null {
    const font = this.textures.font;
    const index = ch.charCodeAt(0) - 0x20;
    if (font && index >= 0 && font.width >= fontCols * fontCellW) {
      const cx = (index % fontCols) * fontCellW;
      const cy = Math.floor(index / fontCols) * fontCellH;
      if (cy + glyphH <= font.height) {
        const rows: number[][] = [];
        for (let y = 0; y < glyphH; y++) {
          const row: number[] = [];
          for (let x = 0; x < glyphW; x++) row.push(font.data[((cy + y) * font.width + cx + x) * 4 + 3] > 127 ? 1 : 0);
          rows.push(row);
        }
        return rows;
      }
    }
    const builtin = builtinDigits[ch];
    return builtin ? builtin.map((r) => [...r].map((c) => (c === '#' ? 1 : 0))) : null;
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
      onlyOn: null,
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
        if (s.onlyOn && !s.onlyOn.includes(code(x, y))) continue;
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

function applyGlyph(g: Glyph, x0: number, y0: number, w: number, h: number, out: Uint8ClampedArray | Uint8Array): void {
  for (let j = 0; j < g.height; j++) {
    const y = g.y + j;
    if (y < y0 || y >= y0 + h) continue;
    for (let i = 0; i < g.width; i++) {
      const x = g.x + i;
      if (x < x0 || x >= x0 + w || !g.bits[j * g.width + i]) continue;
      const k = ((y - y0) * w + (x - x0)) * 4;
      out[k] = g.rgb[0];
      out[k + 1] = g.rgb[1];
      out[k + 2] = g.rgb[2];
      out[k + 3] = 255;
    }
  }
}

/** 半径 reach (ユークリッド距離) 以内に条件を満たすマスがあるか。斜めの境界でも線の太さがそろう */
function isWithin(x: number, y: number, code: (x: number, y: number) => number, reach: number, match: (c: number) => boolean): boolean {
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      if ((dx === 0 && dy === 0) || dx * dx + dy * dy > reach * reach) continue;
      if (match(code(x + dx, y + dy))) return true;
    }
  }
  return false;
}

function isNextToKerb(x: number, y: number, code: (x: number, y: number) => number): boolean {
  const kerb = (c: number) => c === SurfaceCode.kerbRed || c === SurfaceCode.kerbWhite;
  return kerb(code(x + 1, y)) || kerb(code(x - 1, y)) || kerb(code(x, y + 1)) || kerb(code(x, y - 1));
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
