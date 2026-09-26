import { colors } from './colors';

/** Canvas の座標 (800×600 の px) での位置と大きさ */
export interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Placed {
  el: HTMLElement;
  rect: OverlayRect;
  isVisible: boolean;
}

/**
 * Canvas の上に重ねる DOM 要素 (Canvas にはテキスト入力・選択できる文字がないため。network.md「参加者の画面」)。
 * 位置は Canvas の座標で指定し、Canvas の表示サイズ (拡大縮小) に合わせて置き直す。
 * 要素には data-testid を付ける (自動テストで中身を読むため)。シーンを抜けるときは必ず destroy する。
 * 要素の中のキー入力はゲームの Input に届かないようにする (名前の入力中に WASD でカーソルが動かないように)。
 */
export class DomOverlay {
  private readonly placed: Placed[] = [];
  private lastKey = '';
  private readonly onResize = () => this.layout(true);

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('resize', this.onResize);
  }

  /** 読み取り専用のテキスト欄 (コードの表示。選択してコピーできる) */
  addCodeBox(testId: string, rect: OverlayRect): HTMLTextAreaElement {
    const el = document.createElement('textarea');
    el.readOnly = true;
    el.spellcheck = false;
    el.wrap = 'soft';
    el.addEventListener('focus', () => el.select());
    this.style(el, colors.text);
    el.style.resize = 'none';
    el.style.wordBreak = 'break-all';
    return this.add(el, testId, rect);
  }

  /** 貼り付け用のテキスト欄 (Ctrl+V・右クリックの貼り付け。onText に貼られた文字を渡し、欄は空に戻す) */
  addPasteBox(testId: string, rect: OverlayRect, placeholder: string, onText: (text: string) => void): HTMLTextAreaElement {
    const el = document.createElement('textarea');
    el.spellcheck = false;
    el.placeholder = placeholder;
    this.style(el, colors.text);
    el.style.resize = 'none';
    el.style.overflow = 'hidden';
    el.addEventListener('input', () => {
      const text = el.value;
      if (text.trim() === '') return;
      el.value = '';
      // 貼り付けたらメニューのキー操作に戻す
      el.blur();
      onText(text);
    });
    return this.add(el, testId, rect);
  }

  /** 1 行の入力欄 (名前)。filter で入力中の文字を整え、Enter・フォーカスが外れたときに onCommit */
  addTextInput(
    testId: string,
    rect: OverlayRect,
    options: { maxLength: number; filter: (text: string) => string; onCommit: (text: string) => void },
  ): HTMLInputElement {
    const el = document.createElement('input');
    el.type = 'text';
    el.maxLength = options.maxLength;
    el.spellcheck = false;
    el.autocomplete = 'off';
    this.style(el, colors.white);
    el.addEventListener('input', () => {
      const filtered = options.filter(el.value);
      if (filtered !== el.value) el.value = filtered;
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        el.blur();
      }
    });
    el.addEventListener('blur', () => options.onCommit(el.value));
    return this.add(el, testId, rect);
  }

  setVisible(el: HTMLElement, isVisible: boolean): void {
    const p = this.placed.find((q) => q.el === el);
    if (!p || p.isVisible === isVisible) return;
    p.isVisible = isVisible;
    el.style.display = isVisible ? 'block' : 'none';
    if (!isVisible && document.activeElement === el) el.blur();
  }

  move(el: HTMLElement, rect: OverlayRect): void {
    const p = this.placed.find((q) => q.el === el);
    if (!p) return;
    p.rect = rect;
    this.layout(true);
  }

  /** 毎フレーム呼んでよい (Canvas の表示位置が変わったときだけ置き直す) */
  layout(force = false): void {
    const r = this.canvas.getBoundingClientRect();
    const key = `${r.left},${r.top},${r.width},${r.height}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    const sx = r.width / this.canvas.width;
    const sy = r.height / this.canvas.height;
    for (const p of this.placed) {
      const s = p.el.style;
      s.left = `${r.left + window.scrollX + p.rect.x * sx}px`;
      s.top = `${r.top + window.scrollY + p.rect.y * sy}px`;
      s.width = `${p.rect.w * sx}px`;
      s.height = `${p.rect.h * sy}px`;
      s.fontSize = `${Math.max(9, 12 * sy)}px`;
    }
  }

  /** 要素をすべて取り除く */
  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    for (const p of this.placed) p.el.remove();
    this.placed.length = 0;
  }

  private add<T extends HTMLElement>(el: T, testId: string, rect: OverlayRect): T {
    el.dataset.testid = testId;
    el.style.position = 'absolute';
    el.style.boxSizing = 'border-box';
    el.style.margin = '0';
    // 要素の中のキー入力をゲームの Input (window で受けている) に渡さない
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') el.blur();
    });
    el.addEventListener('keyup', (e) => e.stopPropagation());
    document.body.appendChild(el);
    this.placed.push({ el, rect, isVisible: true });
    this.layout(true);
    return el;
  }

  /** style-guide.md §6 のパネル (地 ink、枠 2px surface、角を丸めない) に合わせる */
  private style(el: HTMLElement, color: string): void {
    const s = el.style;
    s.background = colors.ink;
    s.color = color;
    s.border = `2px solid ${colors.surface}`;
    s.borderRadius = '0';
    s.outline = 'none';
    s.padding = '4px 6px';
    s.fontFamily = 'Consolas, "Courier New", monospace';
    s.lineHeight = '1.3';
    s.zIndex = '10';
    el.addEventListener('focus', () => (s.borderColor = colors.white));
    el.addEventListener('blur', () => (s.borderColor = colors.surface));
  }
}
