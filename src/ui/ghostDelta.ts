import { colors } from './colors';
import { formatGhostDelta } from './format';
import { drawPanel } from './panel';
import { drawText, measureText } from './text';

// style-guide.md §6: 前後の車との差と同じ場所 (下中央 x300 y556 w200 h32)
const panelX = 300;
const panelY = 556;
const panelW = 200;
const panelH = 32;

/**
 * タイムアタックのゴースト差 `GHOST -0.23` (下中央)。
 * deltaSeconds は「自分 − ゴースト」(負なら自分が速い)。ゴーストがない・未比較なら null。
 * 設定でゴースト表示がオフのときは呼ばない。
 */
export function drawGhostDelta(ctx: CanvasRenderingContext2D, deltaSeconds: number | null): void {
  drawPanel(ctx, panelX, panelY, panelW, panelH);
  const label = 'GHOST ';
  const value = deltaSeconds === null ? '--.--' : formatGhostDelta(deltaSeconds);
  let color: string = colors.midGrey;
  if (deltaSeconds !== null) {
    if (value.startsWith('-')) color = colors.hudGreen;
    else if (value === '+0.00') color = colors.text;
    else color = colors.red;
  }
  const left = panelX + panelW / 2 - measureText(label + value) / 2;
  drawText(ctx, label, left, panelY + 9, { color: colors.subtext });
  drawText(ctx, value, left + label.length * 12, panelY + 9, { color });
}
