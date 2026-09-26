import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { colors } from '../ui/colors';
import { drawFooterHint, drawMenuList, drawScreenTitle } from '../ui/menuList';
import type { MenuItemView } from '../ui/menuList';
import { drawPanel } from '../ui/panel';
import { drawParagraph } from '../ui/paragraph';
import { drawText } from '../ui/text';
import { drawBackButton } from '../ui/touchUi';
import { clearInviteHandler, setInviteHandler } from './inviteRouter';
import type { Invite } from './inviteRouter';
import { GuestLobbyScene } from './GuestLobbyScene';
import { HostLobbyScene } from './HostLobbyScene';
import { MenuScene } from './MenuScene';
import {
  menuHint,
  moveMenuCursor,
  tappedMenuRow,
  wasBackTapped,
  wasMenuBackPressed,
  wasMenuConfirmPressed,
  wasMenuDownPressed,
  wasMenuUpPressed,
} from './menuKeys';

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
const listLayout = { x: listX, y: listY, width: listW, rowHeight: rowH };

// タッチの端末でロビーを作るときの注意 (network.md「ホストのタブが…」。スマートフォンは裏に回ると通信が止まりやすい)
type WarningItem = 'create' | 'cancel';
const warningItems: readonly WarningItem[] = ['create', 'cancel'];
const warningLabels: Record<WarningItem, string> = { create: 'CREATE ANYWAY', cancel: 'CANCEL' };
const warningPanel = { x: 120, y: 150, w: 560, h: 300 };
const warningLayout = { x: warningPanel.x + 120, y: warningPanel.y + 196, width: warningPanel.w - 240, rowHeight: rowH };

/** マルチプレイの入口 (game-design.md 6 章): ロビーを作る / ロビーに参加 / 戻る */
export class MultiplayerScene implements Scene {
  private selected: number;
  /** ホストの注意を出している間の選択 (出していなければ null) */
  private warningSelected: number | null = null;

  constructor(
    private readonly game: Game,
    initialItem: MultiplayerItem = 'host',
  ) {
    this.selected = Math.max(0, items.indexOf(initialItem));
  }

  /** 開いたまま招待リンクを開いたら、参加画面へ */
  private readonly onInvite = (invite: Invite) => this.game.changeScene(new GuestLobbyScene(this.game, null, invite));

  enter(): void {
    this.game.audio.playBgm('menu-theme');
    setInviteHandler(this.onInvite);
  }

  exit(): void {
    clearInviteHandler(this.onInvite);
  }

  update(): void {
    const { input, audio } = this.game;
    if (this.warningSelected !== null) {
      this.updateWarning();
      return;
    }
    const tapped = tappedMenuRow(this.game, listLayout, items.length);
    if (tapped >= 0) {
      this.selected = tapped;
      this.confirm(items[tapped]);
    } else if (wasMenuUpPressed(input)) {
      this.selected = moveMenuCursor(this.selected, -1, items.length);
      audio.playSe('ui-cursor');
    } else if (wasMenuDownPressed(input)) {
      this.selected = moveMenuCursor(this.selected, 1, items.length);
      audio.playSe('ui-cursor');
    } else if (wasMenuConfirmPressed(input)) {
      this.confirm(items[this.selected]);
    } else if (wasMenuBackPressed(input) || wasBackTapped(this.game)) {
      this.confirm('back');
    }
  }

  private updateWarning(): void {
    const { input, audio } = this.game;
    const current = this.warningSelected ?? 0;
    const tapped = tappedMenuRow(this.game, warningLayout, warningItems.length);
    let chosen: WarningItem | null = null;
    if (tapped >= 0) chosen = warningItems[tapped];
    else if (wasMenuUpPressed(input) || wasMenuDownPressed(input)) {
      this.warningSelected = moveMenuCursor(current, wasMenuUpPressed(input) ? -1 : 1, warningItems.length);
      audio.playSe('ui-cursor');
    } else if (wasMenuConfirmPressed(input)) chosen = warningItems[current];
    else if (wasMenuBackPressed(input) || wasBackTapped(this.game)) chosen = 'cancel';
    if (chosen === 'create') {
      this.warningSelected = null;
      this.createLobby();
    } else if (chosen === 'cancel') {
      this.warningSelected = null;
      audio.playSe('ui-cancel');
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, width, height);
    drawScreenTitle(ctx, 'MULTIPLAYER', width / 2, 48);
    const views: MenuItemView[] = items.map((item) => ({ label: labels[item], isEnabled: true }));
    drawMenuList(ctx, views, this.selected, listLayout);
    drawParagraph(ctx, notes[items[this.selected]], 160, listY + items.length * rowH + 32, 480, { color: colors.subtext, align: 'center' });
    drawParagraph(ctx, 'UP TO 8 PLAYERS. EVERYONE NEEDS THIS PAGE OPEN IN A MODERN BROWSER.', 100, 440, 600, {
      color: colors.midGrey,
      align: 'center',
    });
    if (this.game.pointer.isTouchMode) drawBackButton(ctx);
    drawFooterHint(ctx, menuHint(this.game, 'UP/DOWN: SELECT  ENTER: OK  ESC: BACK'), width / 2, height - 36);
    if (this.warningSelected !== null) this.renderWarning(ctx);
  }

  private renderWarning(ctx: CanvasRenderingContext2D): void {
    const p = warningPanel;
    drawPanel(ctx, p.x, p.y, p.w, p.h, colors.orange);
    drawText(ctx, 'A PC IS RECOMMENDED', p.x + p.w / 2, p.y + 20, { scale: 3, color: colors.orange, align: 'center' });
    drawText(ctx, 'FOR THE HOST', p.x + p.w / 2, p.y + 48, { scale: 3, color: colors.orange, align: 'center' });
    drawParagraph(
      ctx,
      [
        'THE HOST RUNS THE RACE FOR EVERYONE. IF THIS PHONE SLEEPS OR YOU SWITCH APPS, THE RACE STOPS FOR ALL PLAYERS.',
        'KEEP THE SCREEN ON AND THIS PAGE IN FRONT.',
      ],
      p.x + 24, p.y + 88, p.w - 48, { color: colors.text, align: 'center' },
    );
    const views: MenuItemView[] = warningItems.map((item) => ({ label: warningLabels[item], isEnabled: true }));
    drawMenuList(ctx, views, this.warningSelected ?? 0, warningLayout);
  }

  private createLobby(): void {
    this.game.audio.playSe('ui-confirm');
    this.game.changeScene(new HostLobbyScene(this.game, null));
  }

  private confirm(item: MultiplayerItem): void {
    const game = this.game;
    switch (item) {
      case 'host':
        // タッチの端末 (スマートフォン・タブレット) では、先に注意を出す (禁止はしない)
        if (game.pointer.isTouchMode) {
          game.audio.playSe('ui-confirm');
          this.warningSelected = 0;
          break;
        }
        this.createLobby();
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
