import { colors } from './colors';

// style-guide.md §6: 5 ユニット、各 40×64 (間隔 12)、各ユニットに直径 24px のランプを縦に 2 個
const unitW = 40;
const unitH = 64;
const unitGap = 12;
const lampDots = 12;

/** 直径 12 ドットの円を行ごとの [開始, 幅] にしたもの */
const lampRows: Array<[number, number]> = (() => {
  const rows: Array<[number, number]> = [];
  const r = lampDots / 2;
  for (let y = 0; y < lampDots; y++) {
    const dy = y + 0.5 - r;
    const half = Math.floor(Math.sqrt(r * r - dy * dy) + 0.5);
    rows.push([r - half, half * 2]);
  }
  return rows;
})();

/** スタートランプの全体の幅 (px) */
export const startLampsWidth = unitW * 5 + unitGap * 4;

/** ランプのスプライト (ui-lamp-on / ui-lamp-off、12×12 を 2 倍で描く) */
export interface LampImages {
  on: HTMLImageElement;
  off: HTMLImageElement;
}

/**
 * スタートランプ (5 ユニット)。litCount は左から点灯しているユニット数 (0〜5)。
 * 既定の位置は HUD の上中央 (x276 y12)。タイトル画面の飾りにも使う。
 * images を渡すとランプをスプライトで描き、なければコードで円を塗る。
 */
export function drawStartLamps(ctx: CanvasRenderingContext2D, litCount: number, x = 276, y = 12, images: LampImages | null = null): void {
  for (let i = 0; i < 5; i++) {
    const ux = x + i * (unitW + unitGap);
    ctx.fillStyle = colors.surface;
    ctx.fillRect(ux, y, unitW, unitH);
    ctx.fillStyle = colors.ink;
    ctx.fillRect(ux + 2, y + 2, unitW - 4, unitH - 4);
    const lampX = ux + (unitW - lampDots * 2) / 2;
    if (images) {
      const image = i < litCount ? images.on : images.off;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, lampX, y + 6, lampDots * 2, lampDots * 2);
      ctx.drawImage(image, lampX, y + 34, lampDots * 2, lampDots * 2);
      continue;
    }
    const color = i < litCount ? colors.red : colors.surface;
    drawLamp(ctx, lampX, y + 6, color);
    drawLamp(ctx, lampX, y + 34, color);
  }
}

function drawLamp(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  lampRows.forEach(([start, width], row) => ctx.fillRect(x + start * 2, y + row * 2, width * 2, 2));
}
