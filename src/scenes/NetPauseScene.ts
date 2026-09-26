import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { colors } from '../ui/colors';
import { drawMenuList } from '../ui/menuList';
import type { MenuItemView } from '../ui/menuList';
import { drawPanel } from '../ui/panel';
import { drawParagraph } from '../ui/paragraph';
import { drawText } from '../ui/text';
import { moveMenuCursor, wasMenuBackPressed, wasMenuConfirmPressed, wasMenuDownPressed, wasMenuUpPressed } from './menuKeys';
import { SettingsScene } from './SettingsScene';

export interface NetPauseActions {
  onResume: () => void;
  /** 参加者: レースから抜ける (接続を切る)。ホスト: ロビーを閉じる (全員のレースが終わる) */
  onLeave: () => void;
  onSettingsClosed?: () => void;
}

type NetPauseItem = 'resume' | 'settings' | 'leave';

const panelW = 360;
const rowH = 32;

/**
 * オンラインのレース中のメニュー。他の人のレースを止めないので、開いている間も時間は進み、自分の車は操作できない。
 * 走行シーンの上に重ねる (PauseScene と同じ使い方)。isHost ならリタイアの代わりにロビーを閉じる項目を出す。
 * 抜ける操作は 2 回押してもらう (押し間違いでレースから抜けないように)
 */
export class NetPauseScene implements Scene {
  private readonly items: readonly NetPauseItem[] = ['resume', 'settings', 'leave'];
  private readonly labels: Record<NetPauseItem, string>;
  private selected = 0;
  private isLeaveArmed = false;
  private child: Scene | null = null;

  constructor(
    private readonly game: Game,
    private readonly isHost: boolean,
    private readonly actions: NetPauseActions,
  ) {
    this.labels = { resume: 'RESUME', settings: 'SETTINGS', leave: isHost ? 'CLOSE LOBBY' : 'RETIRE' };
    game.audio.playSe('ui-pause');
  }

  update(dt: number): void {
    if (this.child) {
      this.child.update(dt);
      return;
    }
    const { input, audio } = this.game;
    if (wasMenuUpPressed(input)) {
      this.selected = moveMenuCursor(this.selected, -1, this.items.length);
      this.isLeaveArmed = false;
      audio.playSe('ui-cursor');
    } else if (wasMenuDownPressed(input)) {
      this.selected = moveMenuCursor(this.selected, 1, this.items.length);
      this.isLeaveArmed = false;
      audio.playSe('ui-cursor');
    } else if (wasMenuBackPressed(input)) {
      audio.playSe('ui-pause');
      this.actions.onResume();
    } else if (wasMenuConfirmPressed(input)) {
      this.confirm();
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (this.child) {
      this.child.render(ctx);
      return;
    }
    const { width, height } = this.game;
    const panelH = 64 + this.items.length * rowH + 64;
    const x = (width - panelW) / 2;
    const y = Math.round((height - panelH) / 4) * 2;
    drawPanel(ctx, x, y, panelW, panelH);
    drawText(ctx, 'MENU', width / 2, y + 16, { scale: 4, color: colors.white, align: 'center' });
    const views: MenuItemView[] = this.items.map((item) => ({ label: this.labels[item], isEnabled: true }));
    drawMenuList(ctx, views, this.selected, { x: x + 8, y: y + 60, width: panelW - 16, rowHeight: rowH });
    const noteY = y + 60 + this.items.length * rowH + 8;
    const note = this.isLeaveArmed
      ? this.isHost
        ? 'PRESS AGAIN TO END THE RACE FOR EVERYONE.'
        : 'PRESS AGAIN TO LEAVE. YOU WILL NEED A NEW INVITE LINK.'
      : 'THE RACE KEEPS GOING WHILE THIS MENU IS OPEN.';
    drawParagraph(ctx, note, x + 12, noteY, panelW - 24, { color: this.isLeaveArmed ? colors.yellow : colors.subtext });
  }

  private confirm(): void {
    const audio = this.game.audio;
    switch (this.items[this.selected]) {
      case 'resume':
        audio.playSe('ui-pause');
        this.actions.onResume();
        break;
      case 'settings':
        audio.playSe('ui-confirm');
        this.child = new SettingsScene(this.game, () => {
          this.child = null;
          this.actions.onSettingsClosed?.();
        });
        break;
      case 'leave':
        if (!this.isLeaveArmed) {
          this.isLeaveArmed = true;
          audio.playSe('ui-error');
          return;
        }
        audio.playSe('ui-confirm');
        this.actions.onLeave();
        break;
    }
  }
}
