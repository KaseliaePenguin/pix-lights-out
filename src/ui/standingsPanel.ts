import { colors } from './colors';
import { drawPanel } from './panel';
import type { PositionChange } from './PositionChangeTracker';
import type { RaceGap } from './raceGap';
import { formatRaceGap } from './raceGap';
import { teamOf } from './teams';
import { drawText, textAdvance } from './text';

export interface StandingsRow {
  carNumber: number;
  /** 3 文字 (displayAbbr で自車は YOU) */
  abbr: string;
  /** 前の車との差 (先頭は leader) */
  gap: RaceGap;
  isSelf: boolean;
  /** ファステストラップ保持者 (紫の印) */
  hasFastestLap: boolean;
  /** PositionChangeTracker.changeOf の値 */
  change: PositionChange | null;
}

export interface StandingsData {
  /** 見出しの周回 (先頭の車の周回。スタート前は 1) */
  lap: number;
  totalLaps: number;
  /** 先頭から順に (1〜8 行) */
  rows: readonly StandingsRow[];
}

// style-guide.md §6: 左上 x12 y12 w176 (8 行で h184)
const panelX = 12;
const panelY = 12;
const panelW = 176;
const headerH = 24;
const rowH = 20;

/** 順位表 (タイミングタワー)。見出しは `LAP n/N` */
export function drawStandingsPanel(ctx: CanvasRenderingContext2D, data: StandingsData): void {
  const h = headerH + data.rows.length * rowH;
  drawPanel(ctx, panelX, panelY, panelW, h);

  const lapLabel = 'LAP ';
  drawText(ctx, lapLabel, panelX + 6, panelY + 6, { color: colors.subtext });
  const lap = Math.min(Math.max(data.lap, 1), data.totalLaps);
  drawText(ctx, `${lap}/${data.totalLaps}`, panelX + 6 + lapLabel.length * textAdvance(), panelY + 6, { color: colors.white });

  data.rows.forEach((row, i) => {
    const y = panelY + headerH + i * rowH;
    const textY = y + 3;
    if (row.isSelf) {
      ctx.fillStyle = colors.overlay;
      ctx.fillRect(panelX + 2, y, panelW - 4, rowH);
    }
    let positionColor: string = colors.white;
    if (row.change === 'up') positionColor = colors.hudGreen;
    else if (row.change === 'down') positionColor = colors.red;
    drawText(ctx, String(i + 1), panelX + 26, textY, { color: positionColor, align: 'right' });

    ctx.fillStyle = teamOf(row.carNumber).color;
    ctx.fillRect(panelX + 32, y + 2, 4, 16);
    drawText(ctx, String(row.carNumber), panelX + 40, textY, { color: colors.text });
    drawText(ctx, row.abbr, panelX + 54, textY, { color: colors.text });
    if (row.hasFastestLap) {
      ctx.fillStyle = colors.hudPurple;
      ctx.fillRect(panelX + 90, y + 8, 4, 4);
    }

    let gapColor: string = colors.text;
    if (row.gap.kind === 'pit') gapColor = colors.yellow;
    else if (row.gap.kind === 'out') gapColor = colors.midGrey;
    drawText(ctx, formatRaceGap(row.gap), panelX + 170, textY, { color: gapColor, align: 'right' });
  });
}
