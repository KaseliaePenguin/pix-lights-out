import { colors } from './colors';
import { drawPanel } from './panel';
import { drawText, measureText } from './text';

/** 数字の大きさ (1 ドット = 16 px → 5×7 の字形で 40×56 px。画面の 8 ドット単位) */
const scale = 8;
const padding = 16;
/**
 * 板の中心。発進前の自車は画面の中央 (カメラが自車に合う) にいるので、車を隠さないよう走行エリアの上寄りに置く
 */
const centerX = 400;
const centerY = 200;

/**
 * 発進前のカウントダウン 3-2-1 (game-design.md 7.8 節・10.2 節)。
 * 路面の上でも読めるよう、ink の板 (枠 2px surface) の上に白で描く。value が 0 以下なら何も描かない
 */
export function drawCountdown(ctx: CanvasRenderingContext2D, value: number): void {
  if (value <= 0) return;
  const text = String(value);
  const w = measureText(text, scale) + padding * 2;
  const h = 7 * scale + padding * 2;
  const x = Math.round((centerX - w / 2) / 2) * 2;
  const y = Math.round((centerY - h / 2) / 2) * 2;
  drawPanel(ctx, x, y, w, h);
  drawText(ctx, text, centerX, y + padding, { scale, color: colors.white, align: 'center' });
}
