import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { colors } from '../ui/colors';
import { drawStartLamps, startLampsWidth } from '../ui/startLamps';
import { drawText } from '../ui/text';
import { MenuScene } from './MenuScene';
import { wasMenuConfirmPressed } from './menuKeys';

// ロゴ横のスタートランプの演出: 1 秒ごとに 1 灯 → 5 灯で保持 → 全消灯 → 繰り返し
const lampStep = 1;
const lampHold = 1.5;
const lampOff = 2;
const lampCycle = lampStep * 5 + lampHold + lampOff;

/**
 * タイトル画面 (6.1 節)。
 * TODO(assets): タイトルロゴ・一枚絵 (M3) ができたら文字のロゴと差し替える
 */
export class TitleScene implements Scene {
  private time = 0;

  constructor(private readonly game: Game) {}

  enter(): void {
    // TODO(audio): menu-theme を流す
  }

  update(dt: number): void {
    this.time += dt;
    if (wasMenuConfirmPressed(this.game.input)) {
      // TODO(audio): ui-confirm
      this.game.changeScene(new MenuScene(this.game));
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, width, height);

    const t = this.time % lampCycle;
    const lit = t < lampStep * 5 + lampHold ? Math.min(5, Math.floor(t / lampStep) + 1) : 0;
    drawStartLamps(ctx, lit, (width - startLampsWidth) / 2, 152);

    drawText(ctx, 'PIX LIGHTS OUT', width / 2, 256, { scale: 6, color: colors.white, align: 'center' });

    if (Math.floor(this.time * 2) % 2 === 0) {
      drawText(ctx, 'PRESS ENTER', width / 2, 420, { color: colors.text, align: 'center' });
    }
  }
}
