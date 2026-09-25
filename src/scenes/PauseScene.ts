import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { colors } from '../ui/colors';
import { drawMenuList } from '../ui/menuList';
import type { MenuItemView } from '../ui/menuList';
import { drawPanel } from '../ui/panel';
import { drawText } from '../ui/text';
import {
  moveMenuCursor,
  wasMenuBackPressed,
  wasMenuConfirmPressed,
  wasMenuDownPressed,
  wasMenuUpPressed,
} from './menuKeys';
import { SettingsScene } from './SettingsScene';

export interface PauseActions {
  onResume: () => void;
  onRestart: () => void;
  onQuitToMenu: () => void;
  /** 決勝のみ (6.1 節)。渡したときだけ RETIRE を出す */
  onRetire?: () => void;
  /** 設定を閉じたとき (音量・ゴースト表示などを走行画面に反映する機会) */
  onSettingsClosed?: () => void;
}

type PauseItem = 'resume' | 'restart' | 'settings' | 'retire' | 'quit';

const labels: Record<PauseItem, string> = {
  resume: 'RESUME',
  restart: 'RESTART',
  settings: 'SETTINGS',
  retire: 'RETIRE',
  quit: 'QUIT TO MENU',
};

const panelW = 320;
const rowH = 32;

/**
 * ポーズ画面 (1 人用)。走行シーンの上に重ねて使う。
 *
 * 使い方 (走行シーンが子として持つ。changeScene しないので走行シーンの exit/enter は呼ばれない):
 * ```ts
 * // update: Esc で開き、開いている間は走行の更新を止める
 * if (this.pause) { this.pause.update(dt); return; }
 * if (input.wasPressed('Escape')) this.pause = new PauseScene(this.game, { onResume: () => (this.pause = null), ... });
 * // render: 走行画面と HUD を描いたあとに重ねる
 * this.pause?.render(ctx);
 * ```
 * 走行画面は止まった状態のまま見えている (半透明は使わない方針なので、暗くせずに中央のパネルだけ重ねる)。
 */
export class PauseScene implements Scene {
  private readonly items: readonly PauseItem[];
  private selected = 0;
  /** 設定を開いている間の子画面 (全画面) */
  private child: Scene | null = null;

  constructor(
    private readonly game: Game,
    private readonly actions: PauseActions,
  ) {
    this.items = actions.onRetire
      ? ['resume', 'restart', 'settings', 'retire', 'quit']
      : ['resume', 'restart', 'settings', 'quit'];
    // BGM・エンジン音の一時停止 (game.audio.pause / resume) は走行シーン側で行う
    game.audio.playSe('ui-pause');
  }

  update(dt: number): void {
    if (this.child) {
      this.child.update(dt);
      return;
    }
    const { input } = this.game;
    if (wasMenuUpPressed(input)) {
      this.selected = moveMenuCursor(this.selected, -1, this.items.length);
      this.game.audio.playSe('ui-cursor');
    } else if (wasMenuDownPressed(input)) {
      this.selected = moveMenuCursor(this.selected, 1, this.items.length);
      this.game.audio.playSe('ui-cursor');
    } else if (wasMenuBackPressed(input)) {
      this.game.audio.playSe('ui-pause');
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
    const panelH = 64 + this.items.length * rowH + 8;
    const x = (width - panelW) / 2;
    const y = Math.round((height - panelH) / 4) * 2;
    drawPanel(ctx, x, y, panelW, panelH);
    drawText(ctx, 'PAUSE', width / 2, y + 16, { scale: 4, color: colors.white, align: 'center' });
    const views: MenuItemView[] = this.items.map((item) => ({ label: labels[item], isEnabled: true }));
    drawMenuList(ctx, views, this.selected, { x: x + 8, y: y + 60, width: panelW - 16, rowHeight: rowH });
  }

  private confirm(): void {
    switch (this.items[this.selected]) {
      case 'resume':
        this.game.audio.playSe('ui-pause');
        this.actions.onResume();
        break;
      case 'restart':
        this.game.audio.playSe('ui-confirm');
        this.actions.onRestart();
        break;
      case 'settings':
        this.game.audio.playSe('ui-confirm');
        this.child = new SettingsScene(this.game, () => {
          this.child = null;
          this.actions.onSettingsClosed?.();
        });
        break;
      case 'retire':
        this.game.audio.playSe('ui-confirm');
        this.actions.onRetire?.();
        break;
      case 'quit':
        this.game.audio.playSe('ui-confirm');
        this.actions.onQuitToMenu();
        break;
    }
  }
}
