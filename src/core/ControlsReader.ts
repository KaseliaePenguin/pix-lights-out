import type { Controls } from '../shared/controls';
import { clearControls, createControls } from '../shared/controls';
import type { Input } from './Input';

/**
 * 車への入力 (Controls) を作る入力元。キーボード・ゲームパッド (M3) をこの形で実装し、ControlsReader に渡す。
 * read は固定タイムステップの update ごとに 1 回呼ばれる。
 */
export interface ControlSource {
  /** 今のフレームの入力を out に書く (out は毎回 0 に戻してから渡される) */
  read(out: Controls): void;
  /** 使える状態か (ゲームパッドが接続されているかなど) */
  readonly isConnected: boolean;
  /** メッセージの出し分けなど (PRESS R / PRESS Y) に使う */
  readonly kind: 'keyboard' | 'gamepad';
}

export interface KeyBindings {
  throttle: readonly string[];
  brake: readonly string[];
  left: readonly string[];
  right: readonly string[];
  drs: readonly string[];
  reset: readonly string[];
}

/** game-design.md 5.1 節。アクセルとブレーキを左手の別の指に分け、曲がりながらブレーキを踏めるようにする */
export const defaultKeyBindings: KeyBindings = {
  throttle: ['KeyZ'],
  brake: ['KeyX'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  drs: ['Space'],
  reset: ['KeyR'],
};

/** キーボードの入力元。アクセル・ブレーキ・ステアは 0/1 (ステアの平滑化は車の側で行う) */
export class KeyboardControlSource implements ControlSource {
  readonly isConnected = true;
  readonly kind = 'keyboard';

  constructor(private readonly input: Input, private readonly bindings: KeyBindings = defaultKeyBindings) {}

  read(out: Controls): void {
    const b = this.bindings;
    out.throttle = this.anyDown(b.throttle) ? 1 : 0;
    out.brake = this.anyDown(b.brake) ? 1 : 0;
    out.steerInput = (this.anyDown(b.right) ? 1 : 0) - (this.anyDown(b.left) ? 1 : 0);
    out.steerIsAnalog = false;
    out.drsPressed = this.anyPressed(b.drs);
    out.resetPressed = this.anyPressed(b.reset);
  }

  private anyDown(codes: readonly string[]): boolean {
    for (const c of codes) if (this.input.isDown(c)) return true;
    return false;
  }

  private anyPressed(codes: readonly string[]): boolean {
    for (const c of codes) if (this.input.wasPressed(c)) return true;
    return false;
  }
}

/**
 * 複数の入力元をまとめて 1 つの Controls にする (game-design.md 5.2 節)。
 * アクセル・ブレーキは大きい方、ステアは絶対値が大きい方 (その入力元のアナログ/デジタルの区別も引き継ぐ)、
 * ボタンはどれかが押されたら true。
 */
export class ControlsReader {
  private readonly sources: ControlSource[] = [];
  private readonly scratch = createControls();
  /** 最後に操作があった入力元の種類 */
  lastUsedKind: 'keyboard' | 'gamepad' = 'keyboard';

  constructor(sources: ControlSource[] = []) {
    for (const s of sources) this.sources.push(s);
  }

  static withKeyboard(input: Input): ControlsReader {
    return new ControlsReader([new KeyboardControlSource(input)]);
  }

  addSource(source: ControlSource): void {
    this.sources.push(source);
  }

  /** 固定タイムステップの update の中で 1 回呼ぶ (wasPressed を使うため) */
  read(out: Controls): Controls {
    clearControls(out);
    let steerAbs = -1;
    for (const source of this.sources) {
      if (!source.isConnected) continue;
      const c = clearControls(this.scratch);
      source.read(c);
      out.throttle = Math.max(out.throttle, c.throttle);
      out.brake = Math.max(out.brake, c.brake);
      if (Math.abs(c.steerInput) > steerAbs) {
        steerAbs = Math.abs(c.steerInput);
        out.steerInput = c.steerInput;
        out.steerIsAnalog = c.steerIsAnalog;
      }
      out.drsPressed = out.drsPressed || c.drsPressed;
      out.resetPressed = out.resetPressed || c.resetPressed;
      if (c.throttle > 0 || c.brake > 0 || c.steerInput !== 0 || c.drsPressed || c.resetPressed) this.lastUsedKind = source.kind;
    }
    return out;
  }
}
