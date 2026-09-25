import { colors } from './colors';

/** HUD パネル: 地 ink (不透明)、枠 2px surface、角は丸めない (style-guide.md §6) */
export function drawPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  border: string = colors.surface,
): void {
  ctx.fillStyle = border;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = colors.ink;
  ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
}

/** 塗りのない 2px の枠 */
export function drawFrame(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, 2);
  ctx.fillRect(x, y + h - 2, w, 2);
  ctx.fillRect(x, y, 2, h);
  ctx.fillRect(x + w - 2, y, 2, h);
}
