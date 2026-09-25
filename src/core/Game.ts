import { Assets } from './Assets';
import { AudioManager } from './AudioManager';
import { Input } from './Input';
import type { Scene } from './Scene';

/** ゲーム全体を管理し、固定タイムステップでメインループを回す */
export class Game {
  readonly ctx: CanvasRenderingContext2D;
  readonly input: Input;
  readonly assets = new Assets();
  readonly audio: AudioManager;
  readonly width: number;
  readonly height: number;

  private scene: Scene | null = null;
  private lastTime = 0;
  private accumulator = 0;
  private readonly step = 1 / 60;
  private isClockReset = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is not supported');
    this.ctx = ctx;
    this.width = canvas.width;
    this.height = canvas.height;
    this.input = new Input(window);
    this.audio = new AudioManager(this.assets);
    // 最初のキー入力で AudioContext を resume し、タブが隠れている間は止める
    this.audio.attach(window);
  }

  changeScene(next: Scene): void {
    this.scene?.exit?.();
    this.scene = next;
    this.scene.enter?.();
  }

  /**
   * たまった時間を捨てる。重い処理 (コースの生成など) の直後に呼ぶと、その間の時間をまとめて進めない。
   * update の中から呼んでよい (そのフレームの残りの更新は行わない)
   */
  resetClock(): void {
    this.isClockReset = true;
    this.accumulator = 0;
    this.lastTime = performance.now();
  }

  start(): void {
    this.lastTime = performance.now();
    requestAnimationFrame(this.loop);
  }

  private loop = (now: number): void => {
    // タブ復帰時などの巨大な dt を抑える。resetClock の直後は now (フレームの開始時刻) が lastTime より前になりうる
    const dt = Math.max(0, Math.min((now - this.lastTime) / 1000, 0.25));
    this.lastTime = now;
    this.accumulator += dt;

    this.isClockReset = false;
    while (this.accumulator >= this.step) {
      this.scene?.update(this.step);
      this.input.endFrame();
      if (this.isClockReset) {
        this.accumulator = 0;
        break;
      }
      this.accumulator -= this.step;
    }

    this.ctx.clearRect(0, 0, this.width, this.height);
    this.scene?.render(this.ctx);

    requestAnimationFrame(this.loop);
  };
}
