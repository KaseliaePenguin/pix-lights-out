/** キーボード入力の状態を保持する */
export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>();

  constructor(target: Window) {
    target.addEventListener('keydown', (e) => {
      if (!this.held.has(e.code)) this.pressed.add(e.code);
      this.held.add(e.code);
    });
    target.addEventListener('keyup', (e) => this.held.delete(e.code));
    target.addEventListener('blur', () => this.held.clear());
  }

  /** 押し続けている間 true */
  isDown(code: string): boolean {
    return this.held.has(code);
  }

  /** 押された最初の更新フレームだけ true */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  endFrame(): void {
    this.pressed.clear();
  }
}
