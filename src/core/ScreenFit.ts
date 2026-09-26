import type { PointerInput } from './PointerInput';

/** 画面の端の、ノッチ・ホームバーを避ける幅 (CSS px。env(safe-area-inset-*)) */
export interface SafeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** ウィンドウの中での Canvas の表示位置と大きさ (CSS px) */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Canvas をウィンドウに合わせて拡大・縮小する (縦横比 4:3 を保つ。滲まないよう CSS は image-rendering: pixelated)。
 * 1 倍以上に収まるときは整数倍にする (PC のブラウザでドットの大きさを揃える)。1 倍に満たないとき (スマートフォン) は収まる大きさに縮める。
 * タッチの端末が縦向きのときは isRotateNeeded (ROTATE YOUR PHONE を出して、走行はポーズにする)。
 */
export class ScreenFit {
  /** Canvas の表示位置 (CSS px) */
  readonly canvasRect: ScreenRect = { x: 0, y: 0, w: 0, h: 0 };
  readonly insets: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  viewWidth = 0;
  viewHeight = 0;
  /** 1 ゲーム px が何 CSS px か */
  scale = 1;
  /** 大きさ・向きが変わるたびに増える (TouchPad がボタンの配置を作り直す目安) */
  revision = 0;

  private readonly probe: HTMLDivElement;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly pointer: PointerInput,
  ) {
    // env(safe-area-inset-*) の値を読むための見えない要素
    const probe = document.createElement('div');
    const s = probe.style;
    s.position = 'fixed';
    s.left = '0';
    s.top = '0';
    s.width = '0';
    s.height = '0';
    s.visibility = 'hidden';
    s.pointerEvents = 'none';
    s.paddingTop = 'env(safe-area-inset-top, 0px)';
    s.paddingRight = 'env(safe-area-inset-right, 0px)';
    s.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
    s.paddingLeft = 'env(safe-area-inset-left, 0px)';
    document.body.appendChild(probe);
    this.probe = probe;

    const refit = () => this.fit();
    window.addEventListener('resize', refit);
    window.addEventListener('orientationchange', refit);
    window.visualViewport?.addEventListener('resize', refit);
    // 画面のキーボードを閉じたら、ずれたスクロールを戻して合わせ直す (iOS はキーボードを出すときにページをずらす)
    document.addEventListener('focusout', () => {
      window.scrollTo(0, 0);
      requestAnimationFrame(refit);
    });
    this.fit();
  }

  /** タッチの端末が縦向きで、横向きにしてもらう必要があるか */
  get isRotateNeeded(): boolean {
    return this.pointer.isTouchMode && this.viewHeight > this.viewWidth;
  }

  /** 全画面にできるか (Android の Chrome など。iPhone の Safari はできない) */
  get canFullscreen(): boolean {
    const d = document as Document & { webkitFullscreenEnabled?: boolean };
    return Boolean(d.fullscreenEnabled || d.webkitFullscreenEnabled);
  }

  get isFullscreen(): boolean {
    const d = document as Document & { webkitFullscreenElement?: Element | null };
    return Boolean(d.fullscreenElement || d.webkitFullscreenElement);
  }

  /** 全画面を切り替える。タップの直後 (ユーザー操作から数秒以内) に呼ぶ */
  toggleFullscreen(): void {
    const d = document as Document & { webkitExitFullscreen?: () => void };
    if (this.isFullscreen) {
      if (d.exitFullscreen) void d.exitFullscreen().catch(() => undefined);
      else d.webkitExitFullscreen?.();
      return;
    }
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    const done = () => {
      // 全画面のときだけ向きを固定できる (Android の Chrome)。できなければそのまま
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      void orientation?.lock?.('landscape').catch(() => undefined);
    };
    if (el.requestFullscreen) void el.requestFullscreen({ navigationUI: 'hide' }).then(done, () => undefined);
    else el.webkitRequestFullscreen?.();
  }

  /** ウィンドウの大きさに合わせて Canvas の表示サイズを決め直す */
  fit(): void {
    // 画面のキーボードで入力している間は合わせ直さない (Android はキーボードの分だけウィンドウが縮み、Canvas が小さくなるため)
    if (this.pointer.isTouchMode && isTextField(document.activeElement)) return;
    const style = getComputedStyle(this.probe);
    this.insets.top = parseFloat(style.paddingTop) || 0;
    this.insets.right = parseFloat(style.paddingRight) || 0;
    this.insets.bottom = parseFloat(style.paddingBottom) || 0;
    this.insets.left = parseFloat(style.paddingLeft) || 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this.viewWidth = vw;
    this.viewHeight = vh;

    const availW = Math.max(1, vw - this.insets.left - this.insets.right);
    const availH = Math.max(1, vh - this.insets.top - this.insets.bottom);
    const fitScale = Math.min(availW / this.canvas.width, availH / this.canvas.height);
    const scale = fitScale >= 1 ? Math.floor(fitScale) : fitScale;
    const w = Math.floor(this.canvas.width * scale);
    const h = Math.floor(this.canvas.height * scale);
    this.scale = w / this.canvas.width;
    const r = this.canvasRect;
    r.w = w;
    r.h = h;
    r.x = Math.round(this.insets.left + (availW - w) / 2);
    r.y = Math.round(this.insets.top + (availH - h) / 2);
    const s = this.canvas.style;
    s.position = 'absolute';
    s.left = `${r.x}px`;
    s.top = `${r.y}px`;
    s.width = `${w}px`;
    s.height = `${h}px`;
    if (this.pointer.isTouchMode && this.isRotateNeeded) this.pointer.releaseAll();
    this.revision++;
  }
}

function isTextField(el: Element | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}
