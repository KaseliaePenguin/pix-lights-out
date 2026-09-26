import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import type { RaceResult } from '../shared/RaceSession';
import { colors } from '../ui/colors';
import { formatLapTime } from '../ui/format';
import { drawFooterHint, drawMenuList, drawScreenTitle } from '../ui/menuList';
import type { MenuItemView } from '../ui/menuList';
import { formatRaceGap } from '../ui/raceGap';
import { displayAbbr, teamOf } from '../ui/teams';
import { drawText } from '../ui/text';
import { MenuScene } from './MenuScene';
import {
  moveMenuCursor,
  wasMenuBackPressed,
  wasMenuConfirmPressed,
  wasMenuDownPressed,
  wasMenuUpPressed,
} from './menuKeys';
import { RaceScene } from './RaceScene';
import type { RaceSetup } from './raceSetup';
import { newRaceSeed } from './raceSetup';
import { RaceSetupScene } from './RaceSetupScene';

type ResultItem = 'menu' | 'again' | 'setup';

const items: readonly ResultItem[] = ['menu', 'again', 'setup'];
const labels: Record<ResultItem, string> = {
  menu: 'MENU',
  again: 'RACE AGAIN',
  setup: 'RACE SETUP',
};

// 表の列 (px)。数字の列は右揃えの右端、文字の列は左端
const tableTop = 112;
const rowH = 28;
const colPos = 64;
const colBand = 76;
const colNumber = 88;
const colAbbr = 112;
const colTime = 264;
const colGap = 380;
const colBest = 492;
const colStatus = 516;
const colPenalty = 788;
/** 自分の行を強調する帯の左端 (右端も同じだけ空ける) */
const rowLeft = 8;

/**
 * リザルト (game-design.md 6.1 節): 順位、車番・略称、総タイム (ペナルティ込み)、優勝者との差、ベストラップ (全体ベストは紫)、
 * 状態 (未完走・リタイア) とペナルティ。自分の行を強調する。
 * 決定でメニューへ。同じ設定でもう一度走るか、レース設定に戻ることもできる。
 */
export class ResultScene implements Scene {
  private selected = 0;
  private readonly fastestLap: number | null;
  private readonly playerResult: RaceResult | null;

  constructor(
    private readonly game: Game,
    private readonly results: readonly RaceResult[],
    private readonly setup: Readonly<RaceSetup>,
  ) {
    let best: number | null = null;
    for (const r of results) if (r.bestLap !== null && (best === null || r.bestLap < best)) best = r.bestLap;
    this.fastestLap = best;
    this.playerResult = results.find((r) => r.isPlayer) ?? null;
  }

  enter(): void {
    this.game.audio.playBgm('result-theme');
  }

  update(): void {
    const { input, audio } = this.game;
    if (wasMenuUpPressed(input)) {
      this.selected = moveMenuCursor(this.selected, -1, items.length);
      audio.playSe('ui-cursor');
    } else if (wasMenuDownPressed(input)) {
      this.selected = moveMenuCursor(this.selected, 1, items.length);
      audio.playSe('ui-cursor');
    } else if (wasMenuConfirmPressed(input)) {
      this.confirm(items[this.selected]);
    } else if (wasMenuBackPressed(input)) {
      this.confirm('menu');
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, width, height);
    drawScreenTitle(ctx, 'RESULT', width / 2, 24);
    this.renderSummary(ctx);
    this.renderTable(ctx);

    const views: MenuItemView[] = items.map((item) => ({ label: labels[item], isEnabled: true }));
    const listY = tableTop + 24 + 8 * rowH + 20;
    drawMenuList(ctx, views, this.selected, { x: 260, y: listY, width: 280 });
    drawFooterHint(ctx, 'UP/DOWN: SELECT  ENTER: OK  ESC: MENU', width / 2, height - 36);
  }

  private renderSummary(ctx: CanvasRenderingContext2D): void {
    const r = this.playerResult;
    if (!r) return;
    let text = `YOU FINISHED P${r.position}`;
    let color: string = r.position === 1 ? colors.yellow : colors.white;
    if (r.status === 'retired') {
      text = 'YOU RETIRED';
      color = colors.midGrey;
    } else if (r.status === 'unclassified') {
      text = 'YOU WERE NOT CLASSIFIED';
      color = colors.midGrey;
    }
    drawText(ctx, text, this.game.width / 2, 68, { color, align: 'center' });
  }

  private renderTable(ctx: CanvasRenderingContext2D): void {
    const header = { color: colors.subtext };
    drawText(ctx, 'POS', colPos, tableTop, { ...header, align: 'right' });
    drawText(ctx, 'CAR', colNumber, tableTop, header);
    drawText(ctx, 'TIME', colTime, tableTop, { ...header, align: 'right' });
    drawText(ctx, 'GAP', colGap, tableTop, { ...header, align: 'right' });
    drawText(ctx, 'BEST LAP', colBest, tableTop, { ...header, align: 'right' });
    drawText(ctx, 'STATUS', colStatus, tableTop, header);

    this.results.forEach((r, i) => {
      const y = tableTop + 24 + i * rowH;
      const textY = y + 6;
      if (r.isPlayer) {
        ctx.fillStyle = colors.overlay;
        ctx.fillRect(rowLeft, y, this.game.width - rowLeft * 2, rowH - 2);
      }
      const isClassified = r.status === 'finished';
      const valueColor: string = isClassified ? colors.text : colors.midGrey;
      drawText(ctx, String(r.position), colPos, textY, { color: colors.white, align: 'right' });
      ctx.fillStyle = teamOf(r.carNumber).color;
      ctx.fillRect(colBand, y + 4, 4, 18);
      drawText(ctx, String(r.carNumber), colNumber, textY, { color: colors.text });
      drawText(ctx, displayAbbr(r.carNumber, r.isPlayer), colAbbr, textY, { color: colors.text });

      drawText(ctx, isClassified ? formatLapTime(r.totalTime) : '-', colTime, textY, { color: valueColor, align: 'right' });
      // 優勝者は総タイムがあり、リタイアは状態の欄に DNF があるので、差の欄は空ける
      if (r.gapToWinner.kind !== 'leader' && r.gapToWinner.kind !== 'out') {
        drawText(ctx, formatRaceGap(r.gapToWinner), colGap, textY, { color: valueColor, align: 'right' });
      }
      const isFastest = r.bestLap !== null && r.bestLap === this.fastestLap;
      drawText(ctx, formatLapTime(r.bestLap), colBest, textY, {
        color: isFastest ? colors.hudPurple : r.bestLap === null ? colors.midGrey : colors.text,
        align: 'right',
      });

      if (r.status === 'retired') drawText(ctx, 'DNF', colStatus, textY, { color: colors.midGrey });
      else if (r.status === 'unclassified') drawText(ctx, 'NOT CLASSIFIED', colStatus, textY, { color: colors.midGrey });
      if (r.penalty > 0) drawText(ctx, `+${r.penalty} SEC`, colPenalty, textY, { color: colors.yellow, align: 'right' });
    });
  }

  private confirm(item: ResultItem): void {
    const game = this.game;
    switch (item) {
      case 'menu':
        game.audio.playSe('ui-confirm');
        game.changeScene(new MenuScene(game, 'singleRace'));
        break;
      case 'again':
        game.audio.playSe('ui-confirm');
        game.changeScene(new RaceScene(game, this.setup, newRaceSeed()));
        break;
      case 'setup':
        game.audio.playSe('ui-confirm');
        game.changeScene(new RaceSetupScene(game));
        break;
    }
  }
}
