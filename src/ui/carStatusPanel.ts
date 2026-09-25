import { colors } from './colors';
import { drawFrame, drawPanel } from './panel';
import { drawText, measureText } from './text';

/** DRS 表示の 3 状態 (game-design.md 10.1 節) */
export type DrsIndicatorState = 'unavailable' | 'available' | 'active';

export interface CarStatusPanelData {
  /** 表示用の速度 (km/h)。px/秒 からの換算は format.ts の toDisplayKmh */
  speedKmh: number;
  /** 仮想ギア 1〜7。後退中は 'R'、停止中の表示を分けたい場合は 'N' */
  gear: number | 'R' | 'N';
  drs: DrsIndicatorState;
}

// style-guide.md §6: 右下 x588 y488 w200 h100
const panelX = 588;
const panelY = 488;
const panelW = 200;
const panelH = 100;
const left = panelX + 6;
const right = panelX + panelW - 6;

/**
 * 車両状態のパネル (右下)。
 * 2 行目 (y528〜552) はタイヤアイコンと摩耗バーの場所 (M3) なので空けてある。
 */
export function drawCarStatusPanel(ctx: CanvasRenderingContext2D, data: CarStatusPanelData): void {
  drawPanel(ctx, panelX, panelY, panelW, panelH);

  // 1 行目: 速度 (4 倍、3 桁の右揃え) + KM/H + ギア
  const speedRight = left + measureText('000', 4);
  const speed = String(Math.max(0, Math.min(999, Math.round(data.speedKmh))));
  drawText(ctx, speed, speedRight, 494, { scale: 4, color: colors.white, align: 'right' });
  drawText(ctx, 'KM/H', speedRight + 8, 508, { color: colors.subtext });
  drawText(ctx, String(data.gear), right, 494, { scale: 4, color: colors.white, align: 'right' });

  // 3 行目: DRS (56×24)
  drawDrsIndicator(ctx, left, 558, data.drs);
}

function drawDrsIndicator(ctx: CanvasRenderingContext2D, x: number, y: number, state: DrsIndicatorState): void {
  const w = 56;
  const h = 24;
  if (state === 'active') {
    ctx.fillStyle = colors.hudGreen;
    ctx.fillRect(x, y, w, h);
    drawText(ctx, 'DRS', x + w / 2, y + 5, { color: colors.ink, align: 'center' });
    return;
  }
  const color = state === 'available' ? colors.hudGreen : colors.surface;
  drawFrame(ctx, x, y, w, h, color);
  drawText(ctx, 'DRS', x + w / 2, y + 5, {
    color: state === 'available' ? colors.hudGreen : colors.overlay,
    align: 'center',
  });
}
