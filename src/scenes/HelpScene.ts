import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { colors } from '../ui/colors';
import { drawFooterHint, drawScreenTitle } from '../ui/menuList';
import { drawPanel } from '../ui/panel';
import { drawParagraph } from '../ui/paragraph';
import { drawText } from '../ui/text';
import { drawBackButton } from '../ui/touchUi';
import { wasMenuBackPressed, wasMenuConfirmPressed } from './menuKeys';

// game-design.md 5.1 節 (キーボード)・5.4 節 (タッチ)。HUD フォントに小文字・日本語がないため英大文字で書く
// TODO(gamepad): M3 でゲームパッドの割り当ての列を足す (5.2 節)
const controlRows: ReadonlyArray<readonly [action: string, keyboard: string, touch: string]> = [
  ['ACCELERATE', 'Z', 'ACCEL'],
  ['BRAKE / REVERSE', 'X', 'BRAKE'],
  ['STEER LEFT', 'LEFT', '<'],
  ['STEER RIGHT', 'RIGHT', '>'],
  ['DRS', 'SPACE', 'DRS'],
  ['RESET TO TRACK', 'R', 'R'],
  ['PAUSE', 'ESC', 'II'],
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
    // 画面のどこをタップしても戻る (BACK のボタンも同じ)
    if (wasMenuBackPressed(input) || wasMenuConfirmPressed(input) || this.game.pointer.tap) {
      this.game.audio.playSe('ui-cancel');
      this.onBack();
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, width, height);
    drawScreenTitle(ctx, 'CONTROLS', width / 2, 48);

    const panelX = 110;
    const panelY = 96;
    const panelW = 580;
    const rowH = 26;
    const keyX = panelX + 400;
    const touchX = panelX + panelW - 16;
    drawPanel(ctx, panelX, panelY, panelW, 16 + (controlRows.length + 1) * rowH);
    drawText(ctx, 'KEYBOARD', keyX, panelY + 12, { color: colors.midGrey, align: 'right' });
    drawText(ctx, 'TOUCH', touchX, panelY + 12, { color: colors.midGrey, align: 'right' });
    controlRows.forEach(([action, keys, touch], i) => {
      const y = panelY + 12 + (i + 1) * rowH;
      drawText(ctx, action, panelX + 16, y, { color: colors.subtext });
      drawText(ctx, keys, keyX, y, { color: colors.white, align: 'right' });
      drawText(ctx, touch, touchX, y, { color: colors.white, align: 'right' });
    });

    const noteY = panelY + 16 + (controlRows.length + 1) * rowH + 16;
    const lines = [
      'STEERING IS RELATIVE TO THE CAR.',
      'DRS: OPEN IN THE DRS ZONE. BRAKE TO CLOSE.',
      'MENU: UP/DOWN SELECT  ENTER OK  ESC BACK',
      'TOUCH: HOLD LEFT HAND < >, RIGHT HAND BRAKE / ACCEL.',
      'SLIDE A THUMB TO SWITCH. TAP MENU ITEMS TO CHOOSE.',
    ];
    lines.forEach((line, i) => drawText(ctx, line, width / 2, noteY + i * 22, { color: colors.text, align: 'center' }));

    // マルチの注意 (network.md「ホストのタブが…」の 7、「コードに IP アドレスが含まれる」)
    drawParagraph(
      ctx,
      [
        "MULTIPLAYER: IF THE HOST'S COMPUTER GOES TO SLEEP, EVERYONE IS DISCONNECTED.",
        'CONNECTING SENDS YOUR GLOBAL IP ADDRESS TO THE STUN SERVERS (GOOGLE, CLOUDFLARE).',
      ],
      60, noteY + lines.length * 22 + 14, width - 120, { color: colors.subtext, align: 'center' },
    );

    if (this.game.pointer.isTouchMode) drawBackButton(ctx);
    drawFooterHint(ctx, this.game.pointer.isTouchMode ? 'TAP ANYWHERE: BACK' : 'ENTER / ESC: BACK', width / 2, height - 30);
  }
}
