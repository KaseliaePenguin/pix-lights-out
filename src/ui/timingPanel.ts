import { colors } from './colors';
import { formatLapTime } from './format';
import { drawPanel } from './panel';
import { drawText } from './text';

/**
 * 区間・ラップの結果 (game-design.md 10.1 節の色分け)
 * - overall: 全体ベスト (タイムアタックでは保存されている全期間の最速) → 紫
 * - personal: 自己ベスト (セッション内) → 緑
 * - slower: 自己ベストより遅い → 黄
 * - none: 未通過・無効な周 → 灰
 */
export type TimingResult = 'overall' | 'personal' | 'slower' | 'none';

export interface TimingPanelData {
  /** 現在の周の経過時間 (秒)。計測前は null */
  currentLapTime: number | null;
  /** 現在の周が無効 (INVALID LAP) なら true。タイムを灰色にする */
  isCurrentLapInvalid: boolean;
  /** S1〜S3 の結果 (3 要素)。どの周の結果を見せるかは呼び出し側が決める */
  sectors: readonly TimingResult[];
  bestLapTime: number | null;
  /** BEST の色。全体ベストなら 'overall'、それ以外は 'none' (通常色) を想定 */
  bestLapResult: TimingResult;
  lastLapTime: number | null;
  lastLapResult: TimingResult;
  isLastLapInvalid?: boolean;
}

// style-guide.md §6: 右上 x588 y12 w200 h96
const panelX = 588;
const panelY = 12;
const panelW = 200;
const panelH = 96;
const left = panelX + 6;
const right = panelX + panelW - 6;
const sectorBoxW = 60;
const sectorBoxH = 18;
const sectorGap = 4;

/** タイムのパネル (右上) */
export function drawTimingPanel(ctx: CanvasRenderingContext2D, data: TimingPanelData): void {
  drawPanel(ctx, panelX, panelY, panelW, panelH);

  // 1 行目: 現在の周
  drawText(ctx, 'LAP', left, 18, { color: colors.subtext });
  drawText(ctx, formatLapTime(data.currentLapTime), right, 18, {
    color: data.isCurrentLapInvalid ? colors.midGrey : colors.white,
    align: 'right',
  });

  // 2 行目: 区間ボックス
  for (let i = 0; i < 3; i++) {
    const result = data.sectors[i] ?? 'none';
    const x = left + i * (sectorBoxW + sectorGap);
    ctx.fillStyle = sectorBoxColor(result);
    ctx.fillRect(x, 38, sectorBoxW, sectorBoxH);
    drawText(ctx, `S${i + 1}`, x + sectorBoxW / 2, 40, { color: sectorTextColor(result), align: 'center' });
  }

  // 3・4 行目: BEST / LAST
  drawText(ctx, 'BEST', left, 62, { color: colors.subtext });
  drawText(ctx, formatLapTime(data.bestLapTime), right, 62, {
    color: data.bestLapTime === null ? colors.midGrey : lapTimeColor(data.bestLapResult),
    align: 'right',
  });
  drawText(ctx, 'LAST', left, 84, { color: colors.subtext });
  drawText(ctx, formatLapTime(data.lastLapTime), right, 84, {
    color: data.lastLapTime === null || data.isLastLapInvalid ? colors.midGrey : lapTimeColor(data.lastLapResult),
    align: 'right',
  });
}

function sectorBoxColor(result: TimingResult): string {
  switch (result) {
    case 'overall':
      return colors.hudPurple;
    case 'personal':
      return colors.hudGreen;
    case 'slower':
      return colors.yellow;
    case 'none':
      return colors.surface;
  }
}

function sectorTextColor(result: TimingResult): string {
  if (result === 'overall') return colors.white;
  if (result === 'none') return colors.midGrey;
  return colors.ink;
}

/** ラップタイムの文字色。'none' は通常の値の色 */
export function lapTimeColor(result: TimingResult): string {
  switch (result) {
    case 'overall':
      return colors.hudPurple;
    case 'personal':
      return colors.hudGreen;
    case 'slower':
      return colors.yellow;
    case 'none':
      return colors.text;
  }
}
