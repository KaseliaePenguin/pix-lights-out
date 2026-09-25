export type TextAlign = 'left' | 'center' | 'right';

export interface TextOptions {
  /** 1 ドットを何 px で描くか。標準 2、大 4、タイトル 6〜8 (1 は使わない) */
  scale?: number;
  color?: string;
  align?: TextAlign;
}

// scripts/build-pixel-assets.mjs が書き出す ui-font-5x7.png の並び (16 文字 × 4〜5 行、セル 6×8)。
// 0x20-0x5F の 64 文字に加え、5 行目の先頭 2 セルに ▲ (0x60) / ▼ (0x61) がある (style-guide.md §6)
const firstCode = 0x20;
const baseGlyphCount = 64;
const extraSymbols: Record<string, number> = { '▲': 0x60, '▼': 0x61 };
/** ▲ ▼ の字形 (画像が 4 行のままのときに使う。style-guide.md §6 と同じ形) */
const extraPatterns: Record<number, readonly string[]> = {
  0x60: ['.....', '..#..', '.###.', '.###.', '#####', '#####', '.....'],
  0x61: ['.....', '#####', '#####', '.###.', '.###.', '..#..', '.....'],
};
const sheetCols = 16;
const cellW = 6;
const cellH = 8;
const glyphW = 5;
const glyphH = 7;
/** 送り幅 (ドット) */
const advanceDots = 6;

/**
 * 5×7 ドットの等幅ビットマップフォント (ASCII 0x20-0x5F と ▲ ▼)。小文字は大文字にし、字形のない文字は '?'。
 * 画像が読めない間 (読み込み中・未配置) は等幅のシステムフォントで同じ送り幅に描く。
 * ▲ ▼ は画像が 4 行 (96×32) のままでも、同じ字形をコードで塗って描く。
 */
export class BitmapFont {
  private sheet: HTMLImageElement | null = null;
  /** 画像に入っている文字数 (4 行なら 64、5 行なら 80) */
  private sheetGlyphCount = 0;
  /** 色ごとに塗り替えた字形画像。塗り替えられなかった色は null (システムフォントで代用) */
  private readonly tinted = new Map<string, HTMLCanvasElement | null>();

  constructor(src: string) {
    const image = new Image();
    image.onload = () => {
      if (image.width >= sheetCols * cellW && image.height >= (baseGlyphCount / sheetCols) * cellH) {
        this.sheet = image;
        this.sheetGlyphCount = Math.floor(image.height / cellH) * sheetCols;
      } else {
        console.warn(`フォント画像の大きさが想定と違うため、代用フォントで描きます: ${src} (${image.width}x${image.height})`);
      }
    };
    image.onerror = () => {
      console.warn(`フォント画像を読み込めないため、代用フォントで描きます: ${src}`);
    };
    image.src = src;
  }

  hasImage(): boolean {
    return this.sheet !== null;
  }

  /** 1 文字の送り幅 (px) */
  advance(scale = 2): number {
    return advanceDots * scale;
  }

  /** 文字列の描画幅 (px)。末尾の 1 ドットの字間は含めない */
  measure(text: string, scale = 2): number {
    const length = [...text].length;
    if (length === 0) return 0;
    return (length * advanceDots - 1) * scale;
  }

  /** 1 行の文字の高さ (px) */
  lineHeight(scale = 2): number {
    return glyphH * scale;
  }

  /** (x, y) は align に応じた基準点の x と、文字の上端の y */
  draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, options: TextOptions = {}): void {
    const scale = options.scale ?? 2;
    const color = options.color ?? '#cdd6f4';
    const align = options.align ?? 'left';
    const codes = toGlyphCodes(text.toUpperCase());
    if (codes.length === 0) return;
    const width = (codes.length * advanceDots - 1) * scale;
    let left = x;
    if (align === 'center') left = x - width / 2;
    else if (align === 'right') left = x - width;
    // 画面のドット (2px) の格子からずれないよう丸める
    left = Math.round(left / 2) * 2;
    const top = Math.round(y / 2) * 2;

    const tintedSheet = this.sheet ? this.getTintedSheet(this.sheet, color) : null;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = color;
    ctx.font = `bold ${7 * scale}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0x20) continue;
      const glyphX = left + i * advanceDots * scale;
      const index = code - firstCode;
      if (tintedSheet && index < this.sheetGlyphCount) {
        const sx = (index % sheetCols) * cellW;
        const sy = Math.floor(index / sheetCols) * cellH;
        ctx.drawImage(tintedSheet, sx, sy, glyphW, glyphH, glyphX, top, glyphW * scale, glyphH * scale);
      } else if (extraPatterns[code]) {
        drawPattern(ctx, extraPatterns[code], glyphX, top, scale);
      } else {
        // 代用: 等幅のシステムフォントで送り幅の中央に描く
        ctx.fillText(String.fromCharCode(code), glyphX + (glyphW / 2) * scale, top + glyphH * scale);
      }
    }
    ctx.restore();
  }

  /** 白い字形の画像を指定色に塗り替えたものを色ごとにキャッシュする */
  private getTintedSheet(sheet: HTMLImageElement, color: string): HTMLCanvasElement | null {
    const cached = this.tinted.get(color);
    if (cached !== undefined) return cached;
    const canvas = document.createElement('canvas');
    canvas.width = sheet.width;
    canvas.height = sheet.height;
    const c = canvas.getContext('2d');
    if (c === null) {
      this.tinted.set(color, null);
      return null;
    }
    c.drawImage(sheet, 0, 0);
    c.globalCompositeOperation = 'source-in';
    c.fillStyle = color;
    c.fillRect(0, 0, canvas.width, canvas.height);
    this.tinted.set(color, canvas);
    return canvas;
  }
}

/** 描画する文字コード (0x20-0x61) の並びにする。字形のない文字は '?' */
function toGlyphCodes(text: string): number[] {
  const codes: number[] = [];
  for (const ch of text) {
    const extra = extraSymbols[ch];
    const code = ch.charCodeAt(0);
    if (extra !== undefined) codes.push(extra);
    else if (ch.length === 1 && code >= firstCode && code < firstCode + baseGlyphCount) codes.push(code);
    else codes.push(0x3f);
  }
  return codes;
}

/** 5×7 の字形パターンをドット単位で塗る (色は呼び出し側で fillStyle に設定済み) */
function drawPattern(ctx: CanvasRenderingContext2D, rows: readonly string[], x: number, top: number, scale: number): void {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let dx = 0; dx < row.length; dx++) {
      if (row[dx] === '#') ctx.fillRect(x + dx * scale, top + y * scale, scale, scale);
    }
  }
}
