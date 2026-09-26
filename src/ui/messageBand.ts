import { colors } from './colors';
import type { DisplayedMessage } from './MessageQueue';
import { drawText, measureText } from './text';

// style-guide.md §6: 上中央 y88-116。幅はスタートランプ (x276-524) にそろえ、長い文言だけ広げる
const bandY = 88;
const bandH = 28;
const minW = 248;
const centerX = 400;

/** メッセージ帯 (上中央)。message は MessageQueue.getDisplay() の戻り値 */
export function drawMessageBand(ctx: CanvasRenderingContext2D, message: DisplayedMessage | null): void {
  if (message === null) return;
  const textW = measureText(message.text);
  const extra = message.hasChecker ? 48 : 0;
  const w = Math.max(minW, Math.ceil((textW + 24 + extra) / 4) * 4);
  const x = centerX - w / 2;
  ctx.fillStyle = colors.ink;
  ctx.fillRect(x, bandY, w, bandH);
  if (message.isTextVisible) {
    drawText(ctx, message.text, centerX, bandY + 8, { color: message.color, align: 'center' });
  }
  if (message.hasChecker) {
    // 文言の左右に 4×3 マス (1 マス 4px) のチェッカー
    const checkerW = 16;
    drawChecker(ctx, centerX - textW / 2 - 8 - checkerW, bandY + 8);
    drawChecker(ctx, centerX + textW / 2 + 8, bandY + 8);
  }
}

function drawChecker(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const left = Math.round(x / 2) * 2;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      ctx.fillStyle = (row + col) % 2 === 0 ? colors.white : colors.surface;
      ctx.fillRect(left + col * 4, y + row * 4, 4, 4);
    }
  }
}
