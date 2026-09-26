import type { Game } from '../core/Game';
import { ClickTargets } from '../ui/ClickTargets';
import { colors } from '../ui/colors';
import { DomOverlay } from '../ui/DomOverlay';
import type { OverlayRect } from '../ui/DomOverlay';
import { drawButton } from '../ui/lobbyList';
import { drawMenuList } from '../ui/menuList';
import type { MenuItemView } from '../ui/menuList';
import { drawFrame } from '../ui/panel';
import { drawParagraph } from '../ui/paragraph';
import { drawText } from '../ui/text';
import { filterPlayerName } from './netProfile';

/** 知らせ (貼り付けの結果など) を出しておく時間 (秒) */
const toastTime = 8;

export interface LobbyUiOptions {
  /** 画面のどこかで Ctrl+V された (名前の入力欄を除く)、または貼り付け欄に貼られた */
  onPaste: (text: string) => void;
  /** 名前の入力欄で Enter を押した・フォーカスが外れた */
  onNameCommit: (name: string) => void;
  /** 名前の入力欄の位置 */
  nameRect: OverlayRect;
}

/**
 * ロビー画面 (ホスト・参加者) の共通部品: Canvas に重ねる DOM (名前の入力欄)、どこでも Ctrl+V、
 * マウスで押せるメニュー・ボタン、画面下の知らせ。シーンの exit で必ず destroy する。
 */
export class LobbyUi {
  readonly overlay: DomOverlay;
  readonly clicks: ClickTargets;
  readonly nameInput: HTMLInputElement;

  private toastText: string | readonly string[] = '';
  private toastColor: string = colors.text;
  private toastRemaining = 0;
  private readonly onDocumentPaste = (e: ClipboardEvent) => {
    if (e.target === this.nameInput) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text.trim() === '') return;
    e.preventDefault();
    this.options.onPaste(text);
  };

  constructor(
    game: Game,
    private readonly options: LobbyUiOptions,
  ) {
    this.overlay = new DomOverlay(game.canvas);
    this.clicks = new ClickTargets(game.canvas);
    this.nameInput = this.overlay.addTextInput('name-input', options.nameRect, {
      maxLength: 8,
      filter: filterPlayerName,
      onCommit: (text) => options.onNameCommit(text),
    });
    document.addEventListener('paste', this.onDocumentPaste);
  }

  /** 名前の入力中か (ゲームのキー操作を止める) */
  get isEditingName(): boolean {
    return document.activeElement === this.nameInput;
  }

  /** 名前の入力欄の表示を変える (入力中は変えない) */
  showName(name: string): void {
    if (!this.isEditingName && this.nameInput.value !== name) this.nameInput.value = name;
  }

  focusName(): void {
    this.nameInput.focus();
    this.nameInput.select();
  }

  toast(text: string | readonly string[], color: string = colors.yellow): void {
    this.toastText = text;
    this.toastColor = color;
    this.toastRemaining = toastTime;
  }

  clearToast(): void {
    this.toastRemaining = 0;
  }

  update(dt: number): void {
    if (this.toastRemaining > 0) this.toastRemaining -= dt;
  }

  /** 描画の始めに呼ぶ (クリックの判定を作り直し、DOM の位置を合わせる) */
  beginRender(): void {
    this.clicks.clear();
    this.overlay.layout();
  }

  /** メニューを描き、行をクリックで押せるようにする */
  drawMenu(
    ctx: CanvasRenderingContext2D,
    views: readonly MenuItemView[],
    selected: number,
    layout: { x: number; y: number; width: number; rowHeight: number },
    onClick: (index: number) => void,
  ): void {
    drawMenuList(ctx, views, selected, layout);
    views.forEach((_, i) => this.clicks.add({ x: layout.x, y: layout.y + i * layout.rowHeight, w: layout.width, h: layout.rowHeight - 4 }, () => onClick(i)));
  }

  button(ctx: CanvasRenderingContext2D, rect: OverlayRect, label: string, isEnabled: boolean, action: () => void): void {
    drawButton(ctx, rect, label, isEnabled);
    if (isEnabled) this.clicks.add(rect, action);
  }

  /** 画面の上に、いま何をすればよいかを 1 行で出す */
  drawHint(ctx: CanvasRenderingContext2D, text: string, color: string = colors.yellow): void {
    drawText(ctx, text, 12, 34, { color });
  }

  /** 枠付きの大きな案内 (「PRESS ENTER (OR CLICK) / TO COPY …」)。枠の中をクリックしても action を呼ぶ */
  bigPrompt(ctx: CanvasRenderingContext2D, rect: OverlayRect, lines: readonly string[], color: string, action: () => void, scale = 3): void {
    drawFrame(ctx, rect.x, rect.y, rect.w, rect.h, color);
    const lineH = 8 * scale;
    const top = rect.y + (rect.h - lines.length * lineH + scale) / 2;
    lines.forEach((line, i) => drawText(ctx, line, rect.x + rect.w / 2, top + i * lineH, { scale, color, align: 'center' }));
    this.clicks.add(rect, action);
  }

  drawToast(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, maxLines = 2): void {
    if (this.toastRemaining <= 0) return;
    drawParagraph(ctx, this.toastText, x, y, w, { color: this.toastColor, maxLines });
  }

  destroy(): void {
    document.removeEventListener('paste', this.onDocumentPaste);
    this.clicks.destroy();
    this.overlay.destroy();
  }
}
