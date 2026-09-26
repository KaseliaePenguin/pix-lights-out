import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import type { RaceResult } from '../shared/RaceSession';
import { colors } from '../ui/colors';
import { drawFooterHint, drawMenuList, drawScreenTitle } from '../ui/menuList';
import type { MenuItemView } from '../ui/menuList';
import { drawResultTable, resultRowHeight, resultSummary } from '../ui/resultTable';
import { displayAbbr } from '../ui/teams';
import { drawText } from '../ui/text';
import { MenuScene } from './MenuScene';
import {
  afterRaceInputDelay,
  moveMenuCursor,
  wasAfterRaceConfirmPressed,
  wasMenuBackPressed,
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

const tableTop = 112;

/**
 * リザルト (game-design.md 6.1 節): 順位、車番・略称、総タイム (ペナルティ込み)、優勝者との差、ベストラップ (全体ベストは紫)、
 * 状態 (未完走・リタイア) とペナルティ。自分の行を強調する。
 * 決定でメニューへ。同じ設定でもう一度走るか、レース設定に戻ることもできる。
 */
export class ResultScene implements Scene {
  private selected = 0;
  private readonly playerResult: RaceResult | null;
  /** 表示してから入力を受け付けるまでの残り (秒) */
  private inputDelay = afterRaceInputDelay;

  constructor(
    private readonly game: Game,
    private readonly results: readonly RaceResult[],
    private readonly setup: Readonly<RaceSetup>,
  ) {
    this.playerResult = results.find((r) => r.isPlayer) ?? null;
  }

  enter(): void {
    this.game.audio.playBgm('result-theme');
  }

  update(dt: number): void {
    if (this.inputDelay > 0) {
      this.inputDelay -= dt;
      return;
    }
    const { input, audio } = this.game;
    if (wasMenuUpPressed(input)) {
      this.selected = moveMenuCursor(this.selected, -1, items.length);
      audio.playSe('ui-cursor');
    } else if (wasMenuDownPressed(input)) {
      this.selected = moveMenuCursor(this.selected, 1, items.length);
      audio.playSe('ui-cursor');
    } else if (wasAfterRaceConfirmPressed(input)) {
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
    const listY = tableTop + 24 + 8 * resultRowHeight + 20;
    drawMenuList(ctx, views, this.selected, { x: 260, y: listY, width: 280 });
    drawFooterHint(ctx, 'UP/DOWN: SELECT  ENTER: OK  ESC: MENU', width / 2, height - 36);
  }

  private renderSummary(ctx: CanvasRenderingContext2D): void {
    const r = this.playerResult;
    if (!r) return;
    const { text, color } = resultSummary(r);
    drawText(ctx, text, this.game.width / 2, 68, { color, align: 'center' });
  }

  private renderTable(ctx: CanvasRenderingContext2D): void {
    drawResultTable(ctx, this.results, tableTop, this.game.width, (r) => displayAbbr(r.carNumber, r.isPlayer));
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
