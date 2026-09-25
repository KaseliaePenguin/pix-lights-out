import { Input } from './Input';
import type { Scene } from './Scene';

/** ゲーム全体を管理し、固定タイムステップでメインループを回す */
export class Game {
  readonly ctx: CanvasRenderingContext2D;
  readonly input: Input;
  readonly width: number;
  readonly height: number;

  private scene: Scene | null = null;
  private lastTime = 0;
  private accumulator = 0;
  private readonly step = 1 / 60;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is not supported');
    this.ctx = ctx;
    this.width = canvas.width;
    this.height = canvas.height;
    this.input = new Input(window);
  }

  changeScene(next: Scene): void {
    this.scene?.exit?.();
    this.scene = next;
    this.scene.enter?.();
  }

  start(): void {
    this.lastTime = performance.now();
    requestAnimationFrame(this.loop);
  }

  private loop = (now: number): void => {
    // タブ復帰時などの巨大な dt を抑える
    const dt = Math.min((now - this.lastTime) / 1000, 0.25);
    this.lastTime = now;
    this.accumulator += dt;

    while (this.accumulator >= this.step) {
      this.scene?.update(this.step);
      this.input.endFrame();
      this.accumulator -= this.step;
    }

    this.ctx.clearRect(0, 0, this.width, this.height);
    this.scene?.render(this.ctx);

    requestAnimationFrame(this.loop);
  };
}
