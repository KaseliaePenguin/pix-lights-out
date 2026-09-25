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
  const w = Math.max(minW, Math.ceil((textW + 24) / 4) * 4);
  const x = centerX - w / 2;
  ctx.fillStyle = colors.ink;
  ctx.fillRect(x, bandY, w, bandH);
  if (message.isTextVisible) {
    drawText(ctx, message.text, centerX, bandY + 8, { color: message.color, align: 'center' });
  }
}
