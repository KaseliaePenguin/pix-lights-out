import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { colors } from '../ui/colors';
import { formatLapTime } from '../ui/format';
import { drawFooterHint, drawMenuList, drawScreenTitle } from '../ui/menuList';
import type { MenuItemView } from '../ui/menuList';
import { drawText } from '../ui/text';
import { HelpScene } from './HelpScene';
import {
  moveMenuCursor,
  wasMenuBackPressed,
  wasMenuConfirmPressed,
  wasMenuDownPressed,
  wasMenuUpPressed,
} from './menuKeys';
import { PlayScene } from './PlayScene';
import { SettingsScene } from './SettingsScene';
import { loadTimeAttackBest } from './settingsStorage';
import { TitleScene } from './TitleScene';

type MenuItem = 'timeAttack' | 'singleRace' | 'multiplayer' | 'settings' | 'controls';

interface MenuEntry {
  item: MenuItem;
  label: string;
  /** M1 で選べるか。選べない項目にもカーソルは止まり、決定すると ui-error を鳴らす */
  isEnabled: boolean;
}

const entries: readonly MenuEntry[] = [
  { item: 'timeAttack', label: 'TIME ATTACK', isEnabled: true },
  { item: 'singleRace', label: 'SINGLE RACE', isEnabled: false },
  { item: 'multiplayer', label: 'MULTIPLAYER', isEnabled: false },
  { item: 'settings', label: 'SETTINGS', isEnabled: true },
  { item: 'controls', label: 'CONTROLS', isEnabled: true },
];

/** メインメニュー (game-design.md 6 章) */
export class MenuScene implements Scene {
  private selected: number;
  private readonly timeAttackBest = loadTimeAttackBest();

  constructor(
    private readonly game: Game,
    initialItem: MenuItem = 'timeAttack',
  ) {
    this.selected = Math.max(
      0,
      entries.findIndex((e) => e.item === initialItem),
    );
  }

  enter(): void {
    // TODO(audio): menu-theme を流す (タイトルから続けて流れている場合は頭出ししない)
  }

  update(): void {
    const { input } = this.game;
    // 選べない項目にもカーソルを止める (何があるかを見せるため)
    const all = entries.map(() => true);
    if (wasMenuUpPressed(input)) {
      this.selected = moveMenuCursor(this.selected, -1, all);
      // TODO(audio): ui-cursor
    } else if (wasMenuDownPressed(input)) {
      this.selected = moveMenuCursor(this.selected, 1, all);
      // TODO(audio): ui-cursor
    } else if (wasMenuConfirmPressed(input)) {
      this.confirm();
    } else if (wasMenuBackPressed(input)) {
      // TODO(audio): ui-cancel
      this.game.changeScene(new TitleScene(this.game));
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, width, height);
    drawScreenTitle(ctx, 'PIX LIGHTS OUT', width / 2, 48);

    const views: MenuItemView[] = entries.map((e) => ({
      label: e.label,
      isEnabled: e.isEnabled,
      note: e.isEnabled ? undefined : 'SOON',
    }));
    drawMenuList(ctx, views, this.selected, { x: 220, y: 144, width: 360 });

    // 6.1 節: 自己ベスト (タイムアタック)
    const bestY = 144 + entries.length * 32 + 32;
    drawText(ctx, 'TIME ATTACK BEST', 248, bestY, { color: colors.subtext });
    drawText(ctx, formatLapTime(this.timeAttackBest), 568, bestY, {
      color: this.timeAttackBest === null ? colors.midGrey : colors.hudPurple,
      align: 'right',
    });

    drawFooterHint(ctx, 'UP/DOWN: SELECT  ENTER: OK  ESC: BACK', width / 2, height - 36);
  }

  private confirm(): void {
    const entry = entries[this.selected];
    if (!entry.isEnabled) {
      // TODO(audio): ui-error
      return;
    }
    // TODO(audio): ui-confirm
    const game = this.game;
    switch (entry.item) {
      case 'timeAttack':
        // TODO(scene): 基盤ができたら RaceScene (session: 'timeAttack') に差し替える
        game.changeScene(new PlayScene(game));
        break;
      case 'settings':
        game.changeScene(new SettingsScene(game, () => game.changeScene(new MenuScene(game, 'settings'))));
        break;
      case 'controls':
        game.changeScene(new HelpScene(game, () => game.changeScene(new MenuScene(game, 'controls'))));
        break;
      default:
        break;
    }
  }
}
