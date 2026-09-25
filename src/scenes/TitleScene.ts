import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { PlayScene } from './PlayScene';

export class TitleScene implements Scene {
  private time = 0;

  constructor(private readonly game: Game) {}

  update(dt: number): void {
    this.time += dt;
    if (this.game.input.wasPressed('Enter') || this.game.input.wasPressed('Space')) {
      this.game.changeScene(new PlayScene(this.game));
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    ctx.fillStyle = '#cdd6f4';
    ctx.textAlign = 'center';
    ctx.font = 'bold 48px sans-serif';
    ctx.fillText('TEST GAME', width / 2, height / 2 - 20);

    if (Math.floor(this.time * 2) % 2 === 0) {
      ctx.font = '20px sans-serif';
      ctx.fillText('Press Enter / Space to start', width / 2, height / 2 + 40);
    }
  }
}
