import { colors } from './colors';
import { drawPanel } from './panel';
import { drawText, measureText } from './text';

/** [ラベル, 値] の行。値は呼び出し側で文字列にしておく (例: ['GRIP', '0.92']) */
export type DebugRow = readonly [string, string];

/**
 * F3 のデバッグ表示 (開発用)。既定の位置は左側、順位表 (y12-196) の下。
 * 開発用なので走行エリアに少しかかってもよい。
 */
export function drawDebugPanel(ctx: CanvasRenderingContext2D, rows: readonly DebugRow[], x = 12, y = 208): void {
  let labelW = measureText('DEBUG');
  let valueW = 0;
  for (const [label, value] of rows) {
    labelW = Math.max(labelW, measureText(label));
    valueW = Math.max(valueW, measureText(value));
  }
  const w = Math.ceil((labelW + valueW + 12 + 16) / 2) * 2;
  const h = 26 + rows.length * 20;
  drawPanel(ctx, x, y, w, h);
  drawText(ctx, 'DEBUG', x + 6, y + 6, { color: colors.yellow });
  rows.forEach(([label, value], i) => {
    const rowY = y + 26 + i * 20;
    drawText(ctx, label, x + 6, rowY, { color: colors.subtext });
    drawText(ctx, value, x + w - 6, rowY, { color: colors.text, align: 'right' });
  });
}
