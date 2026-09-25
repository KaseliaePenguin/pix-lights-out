import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { Player } from '../entities/Player';
import { TitleScene } from './TitleScene';

export class PlayScene implements Scene {
  private readonly player: Player;

  constructor(private readonly game: Game) {
    this.player = new Player(game.width / 2, game.height / 2);
  }

  update(dt: number): void {
    const { input } = this.game;
    if (input.wasPressed('Escape')) {
      this.game.changeScene(new TitleScene(this.game));
      return;
    }
    this.player.update(dt, input, this.game.width, this.game.height);
  }

  render(ctx: CanvasRenderingContext2D): void {
    this.player.render(ctx);

    ctx.fillStyle = '#a6adc8';
    ctx.textAlign = 'left';
    ctx.font = '14px sans-serif';
    ctx.fillText('Move: WASD / Arrow keys   Back: Esc', 12, 22);
  }
}
