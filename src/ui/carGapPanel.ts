import { colors } from './colors';
import { drawPanel } from './panel';
import type { RaceGap } from './raceGap';
import { formatRaceGap } from './raceGap';
import { drawText } from './text';

// style-guide.md §6: 下中央 x300 y556 w200 h32 (ゴースト差と同じ場所)
const panelX = 300;
const panelY = 556;
const panelW = 200;
const panelH = 32;

/**
 * 前後の車との差 `▲-0.842` / `▼+1.203` (game-design.md 7.5 節)。
 * ahead は前の車との差 (自分が遅れている秒数を正で渡す。表示は `-`)、behind は後ろの車との差 (表示は `+`)。
 * 前 (先頭のとき) や後ろ (最後尾のとき) がいなければ null。
 * 仕様の `▲ -0.842   ▼ +1.203` は 200px に収まらないので、左右半分ずつに分けて ▲▼ と数字の間を詰める。
 */
export function drawCarGapPanel(ctx: CanvasRenderingContext2D, ahead: RaceGap | null, behind: RaceGap | null): void {
  drawPanel(ctx, panelX, panelY, panelW, panelH);
  drawHalf(ctx, '▲', ahead, '-', panelX + panelW / 4);
  drawHalf(ctx, '▼', behind, '+', panelX + (panelW * 3) / 4);
}

function drawHalf(ctx: CanvasRenderingContext2D, arrow: string, gap: RaceGap | null, sign: '+' | '-', centerX: number): void {
  const value = gap === null ? '---' : formatRaceGap(gap, sign);
  drawText(ctx, arrow + value, centerX, panelY + 9, {
    color: gap === null ? colors.midGrey : colors.text,
    align: 'center',
  });
}
