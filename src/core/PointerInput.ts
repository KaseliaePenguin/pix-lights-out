/** Canvas の座標 (800×600 の px) */
export interface CanvasPoint {
  x: number;
  y: number;
}

/** 画面に触れている指 (または押しているペン)。位置はウィンドウの CSS px */
export interface ActiveTouch {
  readonly id: number;
  clientX: number;
  clientY: number;
  /** タップとして扱わない (走行中の操作ボタンの上で押し始めた指など) */
  isClaimed: boolean;
}

interface Pending {
  startX: number;
  startY: number;
  isClaimed: boolean;
  /** Canvas の上 (またはその外の余白) で押し始めたか。DOM の入力欄などで押したものはタップにしない */
  isOnGame: boolean;
}

/** これより大きく動いたらタップではなく「滑らせた」とみなす (CSS px) */
const tapSlop = 16;

/**
 * マウス・タッチの入力 (game-design.md 5.4 節)。メニューのタップと、走行中の操作ボタン (TouchPad) が使う。
 * - タップ: 押して、あまり動かさずに離したら 1 回。位置は Canvas の座標で、固定タイムステップの update の中で読む
 * - タッチの操作をしたら isTouchMode (画面のボタンを出す) になり、キーボード・マウスを使ったら戻る
 */
export class PointerInput {
  /** 画面のボタンを出すか (最後に使ったのがタッチか)。タッチが主の端末 (スマートフォン) では最初から true */
  isTouchMode: boolean;
  /** 入力を受け付けない間 (縦向きで ROTATE YOUR PHONE を出している間) は true にする */
  isBlocked = false;

  private readonly taps: CanvasPoint[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly active = new Map<number, ActiveTouch>();
  /** 指の位置・数が変わったときに呼ぶ (TouchPad がボタンの押し下げを計算し直す) */
  private readonly listeners: ((e: PointerEvent | null) => void)[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.isTouchMode = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    window.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e, true));
    window.addEventListener('pointercancel', (e) => this.onUp(e, false));
    // 入力欄の中のキーは DomOverlay が止めるので、ここに届くのはゲームの操作に使ったキーだけ
    window.addEventListener('keydown', () => {
      this.isTouchMode = false;
    });
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
    // 長押しのメニュー (画像の保存など) を出さない。入力欄の中は除く
    window.addEventListener('contextmenu', (e) => {
      if (!isTextField(e.target)) e.preventDefault();
    });
  }

  /** 今の更新フレームまでにあったタップ (なければ null)。複数あれば最初のもの */
  get tap(): CanvasPoint | null {
    return this.taps[0] ?? null;
  }

  /** 今の更新フレームに、rect の中をタップしたか */
  wasTappedIn(rect: { x: number; y: number; w: number; h: number }): boolean {
    const t = this.tap;
    return t !== null && t.x >= rect.x && t.x < rect.x + rect.w && t.y >= rect.y && t.y < rect.y + rect.h;
  }

  /** 触れている指 (タッチ・ペンのみ。マウスは含まない) */
  get touches(): ReadonlyMap<number, ActiveTouch> {
    return this.active;
  }

  /** 指の数・位置が変わったら呼ばれる。引数は元のイベント (指をすべて離した扱いにしたときは null) */
  onTouchChange(listener: (e: PointerEvent | null) => void): void {
    this.listeners.push(listener);
  }

  /** シーンを切り替えたら、前のシーンで起きたタップを捨てる (新しい画面の同じ位置の項目を押さないように) */
  clearTaps(): void {
    this.taps.length = 0;
  }

  endFrame(): void {
    this.taps.length = 0;
  }

  /** ウィンドウの CSS px を Canvas の座標に変える */
  toCanvas(clientX: number, clientY: number): CanvasPoint {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / r.width) * this.canvas.width,
      y: ((clientY - r.top) / r.height) * this.canvas.height,
    };
  }

  private onDown(e: PointerEvent): void {
    const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
    this.isTouchMode = isTouch;
    if (this.isBlocked) return;
    if (!isTouch && e.button !== 0) return;
    this.pending.set(e.pointerId, {
      startX: e.clientX,
      startY: e.clientY,
      isClaimed: false,
      isOnGame: isGameSurface(e.target, this.canvas),
    });
    if (isTouch) {
      this.active.set(e.pointerId, { id: e.pointerId, clientX: e.clientX, clientY: e.clientY, isClaimed: false });
      this.notify(e);
      // TouchPad がボタンの上で押し始めた指を claim したら、タップにしない
      const a = this.active.get(e.pointerId);
      const p = this.pending.get(e.pointerId);
      if (a && p) p.isClaimed = a.isClaimed;
    }
  }

  private onMove(e: PointerEvent): void {
    const a = this.active.get(e.pointerId);
    if (!a) return;
    a.clientX = e.clientX;
    a.clientY = e.clientY;
    this.notify(e);
  }

  private onUp(e: PointerEvent, isTapCandidate: boolean): void {
    const p = this.pending.get(e.pointerId);
    this.pending.delete(e.pointerId);
    if (this.active.delete(e.pointerId)) this.notify(e);
    if (!p || !isTapCandidate || this.isBlocked || p.isClaimed || !p.isOnGame) return;
    if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > tapSlop) return;
    this.taps.push(this.toCanvas(e.clientX, e.clientY));
  }

  /** 指をすべて離した扱いにする (ウィンドウが裏に回ったとき、縦向きになったとき) */
  releaseAll(): void {
    this.pending.clear();
    if (this.active.size === 0) return;
    this.active.clear();
    this.notify(null);
  }

  private notify(e: PointerEvent | null): void {
    for (const l of this.listeners) l(e);
  }
}

/** ゲームの画面 (Canvas かその外の余白) の上で押したか。重ねた DOM の入力欄・ボタンで押したものは除く */
function isGameSurface(target: EventTarget | null, canvas: HTMLCanvasElement): boolean {
  return target === canvas || target === document.body || target === document.documentElement;
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}
