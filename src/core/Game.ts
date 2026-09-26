import { Assets } from './Assets';
import { AudioManager } from './AudioManager';
import { Input } from './Input';
import { PointerInput } from './PointerInput';
import type { Scene } from './Scene';
import { ScreenFit } from './ScreenFit';
import { TouchPad } from './TouchPad';

/** ゲーム全体を管理し、固定タイムステップでメインループを回す */
export class Game {
  readonly ctx: CanvasRenderingContext2D;
  readonly input: Input;
  /** マウス・タッチ (メニューのタップ、タッチの端末かどうか) */
  readonly pointer: PointerInput;
  /** Canvas の表示サイズ・画面の向き */
  readonly screen: ScreenFit;
  /** 走行中の画面のボタン (タッチの端末だけ) */
  readonly touchPad: TouchPad;
  /** 縦向きのとき (ROTATE YOUR PHONE) に、シーンの上に描くもの (main.ts で設定する) */
  rotateNoticePainter: ((ctx: CanvasRenderingContext2D) => void) | null = null;
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
    this.pointer = new PointerInput(canvas);
    this.screen = new ScreenFit(canvas, this.pointer);
    this.touchPad = new TouchPad(this.pointer, this.screen);
    this.audio = new AudioManager(this.assets);
    // 最初のキー入力で AudioContext を resume し、タブが隠れている間は止める
    this.audio.attach(window);
  }

  changeScene(next: Scene): void {
    this.scene?.exit?.();
    this.pointer.clearTaps();
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
    // 縦向きの間はタップを受け付けない (走行シーンは isRotateNeeded を見てポーズを開く)
    this.pointer.isBlocked = this.screen.isRotateNeeded;
    while (this.accumulator >= this.step) {
      this.scene?.update(this.step);
      this.input.endFrame();
      this.pointer.endFrame();
      this.touchPad.endFrame();
      if (this.isClockReset) {
        this.accumulator = 0;
        break;
      }
      this.accumulator -= this.step;
    }

    this.ctx.clearRect(0, 0, this.width, this.height);
    this.scene?.render(this.ctx);
    if (this.screen.isRotateNeeded) this.rotateNoticePainter?.(this.ctx);
    this.touchPad.present();

    requestAnimationFrame(this.loop);
  };
}
