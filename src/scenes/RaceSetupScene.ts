import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { colors } from '../ui/colors';
import { drawFooterHint, drawMenuList, drawScreenTitle } from '../ui/menuList';
import type { MenuItemView } from '../ui/menuList';
import { teamOf } from '../ui/teams';
import { drawText } from '../ui/text';
import { MenuScene } from './MenuScene';
import {
  moveMenuCursor,
  wasMenuBackPressed,
  wasMenuConfirmPressed,
  wasMenuDownPressed,
  wasMenuLeftPressed,
  wasMenuRightPressed,
  wasMenuUpPressed,
} from './menuKeys';
import { RaceScene } from './RaceScene';
import { difficulties, lapChoices, loadRaceSetup, maxCpuCount, newRaceSeed, saveRaceSetup } from './raceSetup';
import type { RaceSetup } from './raceSetup';

type SetupItem = 'team' | 'cpuCount' | 'difficulty' | 'laps' | 'start' | 'back';

const items: readonly SetupItem[] = ['team', 'cpuCount', 'difficulty', 'laps', 'start', 'back'];

const labels: Record<SetupItem, string> = {
  team: 'TEAM',
  cpuCount: 'CPU CARS',
  difficulty: 'DIFFICULTY',
  laps: 'LAPS',
  start: 'START',
  back: 'BACK',
};

const listX = 180;
const listY = 136;
const listW = 440;
const rowH = 32;

/** レース設定 (game-design.md 6 章。メニューの SINGLE RACE から) */
export class RaceSetupScene implements Scene {
  private readonly setup: RaceSetup = loadRaceSetup();
  private selected: number;

  constructor(
    private readonly game: Game,
    initialItem: SetupItem = 'start',
  ) {
    this.selected = Math.max(0, items.indexOf(initialItem));
  }

  enter(): void {
    this.game.audio.playBgm('menu-theme');
  }

  update(): void {
    const { input, audio } = this.game;
    if (wasMenuUpPressed(input)) {
      this.selected = moveMenuCursor(this.selected, -1, items.length);
      audio.playSe('ui-cursor');
    } else if (wasMenuDownPressed(input)) {
      this.selected = moveMenuCursor(this.selected, 1, items.length);
      audio.playSe('ui-cursor');
    } else if (wasMenuLeftPressed(input)) {
      this.change(-1);
    } else if (wasMenuRightPressed(input)) {
      this.change(1);
    } else if (wasMenuConfirmPressed(input)) {
      this.confirm();
    } else if (wasMenuBackPressed(input)) {
      audio.playSe('ui-cancel');
      this.back();
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, width, height);
    drawScreenTitle(ctx, 'SINGLE RACE', width / 2, 48);

    const s = this.setup;
    const views: MenuItemView[] = items.map((item) => {
      switch (item) {
        case 'team':
          return { label: labels.team, isEnabled: true, value: `${s.carNumber} ${teamOf(s.carNumber).abbr}` };
        case 'cpuCount':
          return { label: labels.cpuCount, isEnabled: true, value: String(s.cpuCount) };
        case 'difficulty':
          return { label: labels.difficulty, isEnabled: true, value: s.difficulty.toUpperCase() };
        case 'laps':
          return { label: labels.laps, isEnabled: true, value: String(s.totalLaps) };
        default:
          return { label: labels[item], isEnabled: true };
      }
    });
    drawMenuList(ctx, views, this.selected, { x: listX, y: listY, width: listW, rowHeight: rowH });

    // 選んだチームの名前と色 (車番の色は順位表・名前タグと同じ)
    const team = teamOf(s.carNumber);
    const infoY = listY + items.length * rowH + 24;
    ctx.fillStyle = team.color;
    ctx.fillRect(listX + 28, infoY - 2, 4, 18);
    drawText(ctx, team.name, listX + 40, infoY, { color: colors.text });
    drawText(ctx, 'NO QUALIFYING: YOU START FROM THE BACK', width / 2, infoY + 40, { color: colors.subtext, align: 'center' });

    drawFooterHint(ctx, 'UP/DOWN: SELECT  LEFT/RIGHT: CHANGE  ENTER: OK  ESC: BACK', width / 2, height - 36);
  }

  private change(step: number): void {
    const s = this.setup;
    const audio = this.game.audio;
    switch (items[this.selected]) {
      case 'team':
        s.carNumber = wrap(s.carNumber - 1 + step, 8) + 1;
        break;
      case 'cpuCount':
        s.cpuCount = wrap(s.cpuCount - 1 + step, maxCpuCount) + 1;
        break;
      case 'difficulty':
        s.difficulty = difficulties[wrap(difficulties.indexOf(s.difficulty) + step, difficulties.length)];
        break;
      case 'laps': {
        // M2 は 3 周だけなので、変えられないことを音で伝える
        if (lapChoices.length <= 1) {
          audio.playSe('ui-error');
          return;
        }
        const index = Math.max(0, lapChoices.indexOf(s.totalLaps));
        s.totalLaps = lapChoices[wrap(index + step, lapChoices.length)];
        break;
      }
      default:
        return;
    }
    saveRaceSetup(s);
    audio.playSe('ui-cursor');
  }

  private confirm(): void {
    const item = items[this.selected];
    if (item === 'start') {
      this.game.audio.playSe('ui-confirm');
      saveRaceSetup(this.setup);
      this.game.changeScene(new RaceScene(this.game, this.setup, newRaceSeed()));
    } else if (item === 'back') {
      this.game.audio.playSe('ui-cancel');
      this.back();
    } else {
      // 値の項目で決定したら、次の値に進める
      this.change(1);
    }
  }

  private back(): void {
    saveRaceSetup(this.setup);
    this.game.changeScene(new MenuScene(this.game, 'singleRace'));
  }
}

function wrap(value: number, count: number): number {
  return ((value % count) + count) % count;
}
