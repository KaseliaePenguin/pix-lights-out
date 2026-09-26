import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { colors } from '../ui/colors';
import { drawFooterHint, drawMenuList, drawScreenTitle } from '../ui/menuList';
import type { MenuItemView } from '../ui/menuList';
import { drawParagraph } from '../ui/paragraph';
import { GuestLobbyScene } from './GuestLobbyScene';
import { HostLobbyScene } from './HostLobbyScene';
import { MenuScene } from './MenuScene';
import { moveMenuCursor, wasMenuBackPressed, wasMenuConfirmPressed, wasMenuDownPressed, wasMenuUpPressed } from './menuKeys';

type MultiplayerItem = 'host' | 'join' | 'back';

const items: readonly MultiplayerItem[] = ['host', 'join', 'back'];
const labels: Record<MultiplayerItem, string> = {
  host: 'CREATE LOBBY',
  join: 'JOIN LOBBY',
  back: 'BACK',
};
const notes: Record<MultiplayerItem, string> = {
  host: 'BE THE HOST. SEND AN INVITE LINK TO EACH PLAYER AND PASTE THEIR REPLY CODES.',
  join: 'OPEN THE INVITE LINK FROM THE HOST (OR PASTE IT HERE) AND SEND YOUR REPLY CODE BACK.',
  back: '',
};

const listX = 220;
const listY = 160;
const listW = 360;
const rowH = 32;

/** マルチプレイの入口 (game-design.md 6 章): ロビーを作る / ロビーに参加 / 戻る */
export class MultiplayerScene implements Scene {
  private selected: number;

  constructor(
    private readonly game: Game,
    initialItem: MultiplayerItem = 'host',
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
    } else if (wasMenuConfirmPressed(input)) {
      this.confirm(items[this.selected]);
    } else if (wasMenuBackPressed(input)) {
      this.confirm('back');
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, width, height);
    drawScreenTitle(ctx, 'MULTIPLAYER', width / 2, 48);
    const views: MenuItemView[] = items.map((item) => ({ label: labels[item], isEnabled: true }));
    drawMenuList(ctx, views, this.selected, { x: listX, y: listY, width: listW, rowHeight: rowH });
    drawParagraph(ctx, notes[items[this.selected]], 160, listY + items.length * rowH + 32, 480, { color: colors.subtext, align: 'center' });
    drawParagraph(ctx, 'UP TO 8 PLAYERS. EVERYONE NEEDS THIS PAGE OPEN IN A MODERN BROWSER.', 100, 440, 600, {
      color: colors.midGrey,
      align: 'center',
    });
    drawFooterHint(ctx, 'UP/DOWN: SELECT  ENTER: OK  ESC: BACK', width / 2, height - 36);
  }

  private confirm(item: MultiplayerItem): void {
    const game = this.game;
    switch (item) {
      case 'host':
        game.audio.playSe('ui-confirm');
        game.changeScene(new HostLobbyScene(game, null));
        break;
      case 'join':
        game.audio.playSe('ui-confirm');
        game.changeScene(new GuestLobbyScene(game, null));
        break;
      case 'back':
        game.audio.playSe('ui-cancel');
        game.changeScene(new MenuScene(game, 'multiplayer'));
        break;
    }
  }
}
