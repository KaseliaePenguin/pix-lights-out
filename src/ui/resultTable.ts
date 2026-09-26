import type { RaceResult } from '../shared/RaceSession';
import { colors } from './colors';
import { formatLapTime } from './format';
import { formatRaceGap } from './raceGap';
import { teamOf } from './teams';
import { drawText } from './text';

// 表の列 (px)。数字の列は右揃えの右端、文字の列は左端。
// 差は最大 7 文字 (+1:02.3、+12 LAP でも 7)、タイムは 8 文字 (0:39.058) なので、隣の列との間を 12px 以上あける
const rowH = 28;
const colPos = 64;
const colBand = 76;
const colNumber = 88;
const colAbbr = 112;
const colTimeBase = 264;
const colGapBase = 380;
const colBestBase = 492;
const colStatusBase = 516;
const colPenalty = 788;
/** 自分の行を強調する帯の左端 (右端も同じだけ空ける) */
const rowLeft = 8;

export const resultRowHeight = rowH;

/** 上の 1 行 (YOU FINISHED P3 など) の文言と色 */
export function resultSummary(r: RaceResult): { text: string; color: string } {
  if (r.status === 'retired') return { text: 'YOU RETIRED', color: colors.midGrey };
  if (r.status === 'unclassified') return { text: 'YOU WERE NOT CLASSIFIED', color: colors.midGrey };
  return { text: `YOU FINISHED P${r.position}`, color: r.position === 1 ? colors.yellow : colors.white };
}

/**
 * リザルトの表 (game-design.md 6.3 節): 順位、チーム色の帯、車番・呼び名、総タイム (ペナルティ込み)、優勝者との差、
 * ベストラップ (全体ベストは紫)、状態 (DNF / NOT CLASSIFIED)、ペナルティ。自分の行を強調する。
 * nameOf は呼び名 (1 人用は略称と YOU、オンラインはプレイヤー名。8 文字まで)。isLongNames なら名前の列を広げ、右の列を詰める
 */
export function drawResultTable(
  ctx: CanvasRenderingContext2D,
  results: readonly RaceResult[],
  top: number,
  width: number,
  nameOf: (r: RaceResult) => string,
  isLongNames = false,
): void {
  const colTime = isLongNames ? colTimeBase + 56 : colTimeBase;
  const colGap = isLongNames ? colGapBase + 40 : colGapBase;
  const colBest = isLongNames ? colBestBase + 40 : colBestBase;
  const colStatus = isLongNames ? colStatusBase + 32 : colStatusBase;
  let fastestLap: number | null = null;
  for (const r of results) if (r.bestLap !== null && (fastestLap === null || r.bestLap < fastestLap)) fastestLap = r.bestLap;
  const header = { color: colors.subtext };
  drawText(ctx, 'POS', colPos, top, { ...header, align: 'right' });
  drawText(ctx, 'CAR', colNumber, top, header);
  drawText(ctx, 'TIME', colTime, top, { ...header, align: 'right' });
  drawText(ctx, 'GAP', colGap, top, { ...header, align: 'right' });
  drawText(ctx, 'BEST LAP', colBest, top, { ...header, align: 'right' });
  drawText(ctx, 'STATUS', colStatus, top, header);

  results.forEach((r, i) => {
    const y = top + 24 + i * rowH;
    const textY = y + 6;
    if (r.isPlayer) {
      ctx.fillStyle = colors.overlay;
      ctx.fillRect(rowLeft, y, width - rowLeft * 2, rowH - 2);
    }
    const isClassified = r.status === 'finished';
    const valueColor: string = isClassified ? colors.text : colors.midGrey;
    drawText(ctx, String(r.position), colPos, textY, { color: colors.white, align: 'right' });
    ctx.fillStyle = teamOf(r.carNumber).color;
    ctx.fillRect(colBand, y + 4, 4, 18);
    drawText(ctx, String(r.carNumber), colNumber, textY, { color: colors.text });
    drawText(ctx, nameOf(r), colAbbr, textY, { color: colors.text });

    drawText(ctx, isClassified ? formatLapTime(r.totalTime) : '-', colTime, textY, { color: valueColor, align: 'right' });
    // 優勝者は総タイムがあり、リタイアは状態の欄に DNF があるので、差の欄は空ける
    if (r.gapToWinner.kind !== 'leader' && r.gapToWinner.kind !== 'out') {
      drawText(ctx, formatRaceGap(r.gapToWinner), colGap, textY, { color: valueColor, align: 'right' });
    }
    const isFastest = r.bestLap !== null && r.bestLap === fastestLap;
    drawText(ctx, formatLapTime(r.bestLap), colBest, textY, {
      color: isFastest ? colors.hudPurple : r.bestLap === null ? colors.midGrey : colors.text,
      align: 'right',
    });

    if (r.status === 'retired') drawText(ctx, 'DNF', colStatus, textY, { color: colors.midGrey });
    else if (r.status === 'unclassified') drawText(ctx, 'NOT CLASSIFIED', colStatus, textY, { color: colors.midGrey });
    if (r.penalty > 0) drawText(ctx, `+${r.penalty} SEC`, colPenalty, textY, { color: colors.yellow, align: 'right' });
  });
}
