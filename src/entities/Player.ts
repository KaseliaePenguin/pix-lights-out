import type { Input } from '../core/Input';

export class Player {
  readonly size = 32;
  private readonly speed = 240;

  constructor(public x: number, public y: number) {}

  update(dt: number, input: Input, boundsW: number, boundsH: number): void {
    let dx = 0;
    let dy = 0;
    if (input.isDown('ArrowLeft') || input.isDown('KeyA')) dx -= 1;
    if (input.isDown('ArrowRight') || input.isDown('KeyD')) dx += 1;
    if (input.isDown('ArrowUp') || input.isDown('KeyW')) dy -= 1;
    if (input.isDown('ArrowDown') || input.isDown('KeyS')) dy += 1;

    // 斜め移動が速くならないよう正規化
    if (dx !== 0 && dy !== 0) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }

    const half = this.size / 2;
    this.x = Math.min(Math.max(this.x + dx * this.speed * dt, half), boundsW - half);
    this.y = Math.min(Math.max(this.y + dy * this.speed * dt, half), boundsH - half);
  }

  render(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = '#89b4fa';
    ctx.fillRect(this.x - this.size / 2, this.y - this.size / 2, this.size, this.size);
  }
}
