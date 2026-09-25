/**
 * ブラウザの既定動作 (スクロール、F3 の検索、Tab のフォーカス移動など) を止めるキー。
 * F5・F12・Ctrl/Alt/Meta 付きの操作は止めない。
 */
const defaultBlockedKeys: readonly string[] = [
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR',
  'Space', 'Enter', 'Escape', 'Tab', 'Backspace', 'F3',
];

/** キーボード入力の状態を保持する */
export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>();
  private readonly blockedKeys = new Set<string>(defaultBlockedKeys);
  private blurred = false;

  constructor(target: Window) {
    target.addEventListener('keydown', (e) => {
      this.blockDefault(e);
      if (!this.held.has(e.code)) this.pressed.add(e.code);
      this.held.add(e.code);
    });
    target.addEventListener('keyup', (e) => {
      this.blockDefault(e);
      this.held.delete(e.code);
    });
    target.addEventListener('blur', () => {
      this.held.clear();
      this.blurred = true;
    });
  }

  /** 押し続けている間 true */
  isDown(code: string): boolean {
    return this.held.has(code);
  }

  /** 押された最初の更新フレームだけ true */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  /**
   * 前回の更新からウィンドウがフォーカスを失ったら、最初の更新フレームだけ true。
   * 走行画面が自動でポーズを開くのに使う (押していたキーはこの時点で解除済み)
   */
  wasBlurred(): boolean {
    return this.blurred;
  }

  /** ブラウザの既定動作を止めるキーを追加する */
  blockKey(code: string): void {
    this.blockedKeys.add(code);
  }

  endFrame(): void {
    this.pressed.clear();
    this.blurred = false;
  }

  private blockDefault(e: KeyboardEvent): void {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (this.blockedKeys.has(e.code)) e.preventDefault();
  }
}
