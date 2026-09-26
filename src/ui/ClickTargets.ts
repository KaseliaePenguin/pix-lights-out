import type { OverlayRect } from './DomOverlay';

interface Target {
  rect: OverlayRect;
  action: () => void;
}

/**
 * Canvas に描いたボタン・メニューの行をマウスでも押せるようにする (ロビーはコードのコピー・貼り付けでマウスを使うため)。
 * 描画のたびに clear してから add し直す。押されたら後から足したもの (上に描いたもの) を優先する。
 * クリックの処理はクリックのイベントの中で呼ぶ (クリップボードの操作にユーザー操作が要るため)。
 */
export class ClickTargets {
  private readonly targets: Target[] = [];
  private readonly onClick = (e: MouseEvent) => this.handleClick(e);

  constructor(private readonly canvas: HTMLCanvasElement) {
    canvas.addEventListener('click', this.onClick);
  }

  clear(): void {
    this.targets.length = 0;
  }

  add(rect: OverlayRect, action: () => void): void {
    this.targets.push({ rect, action });
  }

  destroy(): void {
    this.canvas.removeEventListener('click', this.onClick);
    this.targets.length = 0;
  }

  private handleClick(e: MouseEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * this.canvas.width;
    const y = ((e.clientY - r.top) / r.height) * this.canvas.height;
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i].rect;
      if (x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) {
        this.targets[i].action();
        return;
      }
    }
  }
}
