import type { PointerInput } from './PointerInput';
import type { ScreenFit } from './ScreenFit';

/** 走行中の画面のボタン (game-design.md 5.4 節) */
export type TouchButton = 'left' | 'right' | 'brake' | 'throttle' | 'drs' | 'reset' | 'pause';

/** 押している間だけ効くボタン。指を滑らせて隣のボタンへ移れる */
const holdButtons: readonly TouchButton[] = ['left', 'right', 'brake', 'throttle'];

export interface TouchButtonView {
  readonly button: TouchButton;
  /** ウィンドウの CSS px */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 指が乗っている */
  isHeld: boolean;
}

export interface TouchPadOptions {
  /** コース復帰が使えるとき (PRESS R TO RESET を出しているとき)。R を目立たせる */
  highlightReset?: boolean;
  /** DRS が使えるとき */
  highlightDrs?: boolean;
}

/** show が途切れてからボタンを消すまで (ms)。更新が描画より少ないフレーム (120Hz の画面など) でちらつかないように */
const showHoldMs = 150;
/** 見た目より外側でも押した扱いにする幅 (CSS px) */
const hitSlop = 10;

/**
 * 走行中の画面のボタン (タッチの端末だけ)。ゲーム画面の左右の余白 (足りなければゲーム画面に重ねて) に置く。
 * 走行シーンが update のたびに show を呼んでいる間だけ出る。描画は painter (src/ui の関数) に任せ、ゲームの Canvas とは別の、
 * ウィンドウ全体を覆う Canvas (指の入力は通す) に描く。車への入力は ControlsReader の TouchControlSource が読む。
 */
export class TouchPad {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly buttons: TouchButtonView[] = [];
  /** 描画の 1 ドットの大きさ (CSS px) */
  dot = 2;
  options: Readonly<TouchPadOptions> = {};
  /** ボタンを描く関数 (main.ts で設定する) */
  painter: ((pad: TouchPad) => void) | null = null;

  private lastShowTime = -Infinity;
  private readonly pressed = new Set<TouchButton>();
  /** 指ごとの、押し始めたボタン */
  private readonly startButtons = new Map<number, TouchButton>();
  private layoutRevision = -1;
  private isDrawn = false;

  constructor(
    private readonly pointer: PointerInput,
    private readonly screen: ScreenFit,
  ) {
    const canvas = document.createElement('canvas');
    canvas.dataset.testid = 'touch-pad';
    const s = canvas.style;
    s.position = 'fixed';
    s.left = '0';
    s.top = '0';
    s.width = '100%';
    s.height = '100%';
    s.pointerEvents = 'none';
    s.imageRendering = 'pixelated';
    s.zIndex = '5';
    document.body.appendChild(canvas);
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is not supported');
    this.ctx = ctx;
    pointer.onTouchChange((e) => this.updateHeld(e));
  }

  /** 走行シーンが操作を受け付けている間、update のたびに呼ぶ */
  show(options: Readonly<TouchPadOptions> = {}): void {
    this.lastShowTime = performance.now();
    this.options = options;
  }

  /** ボタンを出しているか (タッチの端末で、走行シーンが show を呼んでいて、縦向きでない) */
  get isActive(): boolean {
    return this.pointer.isTouchMode && !this.screen.isRotateNeeded && performance.now() - this.lastShowTime < showHoldMs;
  }

  /** 指が乗っている間 true */
  isHeld(button: TouchButton): boolean {
    if (!this.isActive) return false;
    return this.buttons.some((b) => b.button === button && b.isHeld);
  }

  /** 押した最初の更新フレームだけ true (DRS・R・ポーズ) */
  wasPressed(button: TouchButton): boolean {
    return this.isActive && this.pressed.has(button);
  }

  endFrame(): void {
    this.pressed.clear();
  }

  /** Game が毎フレームの描画のあとに呼ぶ */
  present(): void {
    if (!this.isActive) {
      if (this.isDrawn) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.isDrawn = false;
      }
      return;
    }
    this.ensureLayout();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.painter?.(this);
    this.isDrawn = true;
  }

  private ensureLayout(): void {
    const screen = this.screen;
    if (this.layoutRevision === screen.revision && this.buttons.length > 0) return;
    this.layoutRevision = screen.revision;
    const W = screen.viewWidth;
    const H = screen.viewHeight;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const d = 2;
    this.dot = d;
    const even = (v: number) => Math.round(v / d) * d;
    const inset = screen.insets;
    const margin = 10;
    const u = even(clamp(H * 0.19, 52, 96));
    const gap = even(u * 0.12);
    const left = even(inset.left + margin);
    const right = even(W - inset.right - margin);
    const bottom = even(H - Math.max(inset.bottom, margin));
    const top = even(inset.top + margin);

    // ハンドルはいちばん長く押し続けるので大きめにする (スマートフォンで小さいと言われたため)
    const steerW = even(u * 1.35);
    const steerH = even(u * 1.65);
    const brakeW = even(u * 0.95);
    const brakeH = even(u * 1.1);
    const accelW = u;
    const accelH = even(u * 1.5);
    const small = even(u * 0.62);

    const place = (button: TouchButton, x: number, y: number, w: number, h: number): TouchButtonView => ({ button, x, y, w, h, isHeld: false });
    const steerY = bottom - steerH;
    const accelX = right - accelW;
    const accelY = bottom - accelH;
    const brakeX = accelX - gap - brakeW;
    this.buttons.length = 0;
    this.buttons.push(
      place('left', left, steerY, steerW, steerH),
      place('right', left + steerW + gap, steerY, steerW, steerH),
      place('throttle', accelX, accelY, accelW, accelH),
      place('brake', brakeX, bottom - brakeH, brakeW, brakeH),
      place('reset', left, steerY - gap * 2 - small, small, small),
      place('drs', right - small, accelY - gap * 2 - small, small, small),
      place('pause', left, top, small, small),
    );
    this.updateHeld(null);
  }

  /** 指の位置から、押しているボタンを計算し直す */
  private updateHeld(e: PointerEvent | null): void {
    const touches = this.pointer.touches;
    for (const id of this.startButtons.keys()) if (!touches.has(id)) this.startButtons.delete(id);
    if (this.buttons.length === 0) return;
    for (const b of this.buttons) b.isHeld = false;
    if (!this.isActive) return;
    for (const touch of touches.values()) {
      const b = this.buttonAt(touch.clientX, touch.clientY);
      const isDownNow = e !== null && e.type === 'pointerdown' && e.pointerId === touch.id;
      if (isDownNow && b) {
        touch.isClaimed = true;
        this.startButtons.set(touch.id, b.button);
        if (!holdButtons.includes(b.button)) this.pressed.add(b.button);
      }
      if (!b) continue;
      // 押す・離すボタン (DRS・R・ポーズ) は、その上で押し始めた指だけ (滑ってきた指でポーズが開かないように)
      if (!holdButtons.includes(b.button) && this.startButtons.get(touch.id) !== b.button) continue;
      b.isHeld = true;
    }
  }

  /** (x, y) にあるボタン。見た目より少し外まで含め、重なるときは中心が近い方 */
  private buttonAt(x: number, y: number): TouchButtonView | null {
    let best: TouchButtonView | null = null;
    let bestDistance = Infinity;
    for (const b of this.buttons) {
      if (x < b.x - hitSlop || x >= b.x + b.w + hitSlop || y < b.y - hitSlop || y >= b.y + b.h + hitSlop) continue;
      const distance = Math.hypot(x - (b.x + b.w / 2), y - (b.y + b.h / 2));
      if (distance < bestDistance) {
        best = b;
        bestDistance = distance;
      }
    }
    return best;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
