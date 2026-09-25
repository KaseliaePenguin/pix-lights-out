import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { colors } from '../ui/colors';
import { drawFooterHint, drawScreenTitle } from '../ui/menuList';
import { drawPanel } from '../ui/panel';
import { drawText } from '../ui/text';
import { wasMenuBackPressed, wasMenuConfirmPressed } from './menuKeys';

// game-design.md 5.1 節。HUD フォントに小文字・日本語がないため英大文字で書く
// TODO(gamepad): M3 でゲームパッドの割り当ての列を足す (5.2 節)
const controlRows: ReadonlyArray<readonly [string, string]> = [
  ['ACCELERATE', 'Z'],
  ['BRAKE / REVERSE', 'X'],
  ['STEER LEFT', 'LEFT'],
  ['STEER RIGHT', 'RIGHT'],
  ['DRS', 'SPACE'],
  ['RESET TO TRACK', 'R'],
  ['PAUSE', 'ESC'],
];

/**
 * 操作説明 (設定の「操作確認」、メニューの「CONTROLS」)。
 * 戻り先は呼び出し側が onBack で決める (単独のシーンとしても、他のシーンの子としても使える)。
 */
export class HelpScene implements Scene {
  constructor(
    private readonly game: Game,
    private readonly onBack: () => void,
  ) {}

  update(): void {
    const { input } = this.game;
    if (wasMenuBackPressed(input) || wasMenuConfirmPressed(input)) {
      this.game.audio.playSe('ui-cancel');
      this.onBack();
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, width, height);
    drawScreenTitle(ctx, 'CONTROLS', width / 2, 48);

    const panelX = 150;
    const panelY = 112;
    const panelW = 500;
    drawPanel(ctx, panelX, panelY, panelW, 24 + controlRows.length * 28);
    controlRows.forEach(([action, keys], i) => {
      const y = panelY + 16 + i * 28;
      drawText(ctx, action, panelX + 16, y, { color: colors.subtext });
      drawText(ctx, keys, panelX + panelW - 16, y, { color: colors.white, align: 'right' });
    });

    const noteY = panelY + 24 + controlRows.length * 28 + 24;
    drawText(ctx, 'STEERING IS RELATIVE TO THE CAR.', width / 2, noteY, { color: colors.text, align: 'center' });
    drawText(ctx, 'DRS: OPEN IN THE DRS ZONE. BRAKE TO CLOSE.', width / 2, noteY + 24, {
      color: colors.text,
      align: 'center',
    });
    drawText(ctx, 'MENU: UP/DOWN SELECT  ENTER OK  ESC BACK', width / 2, noteY + 48, {
      color: colors.text,
      align: 'center',
    });

    drawFooterHint(ctx, 'ENTER / ESC: BACK', width / 2, height - 36);
  }
}
