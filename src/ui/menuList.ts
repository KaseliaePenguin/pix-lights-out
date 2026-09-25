import { colors } from './colors';
import { drawText } from './text';

export interface MenuItemView {
  label: string;
  /** false なら灰色で描く (選べない項目) */
  isEnabled: boolean;
  /** 右側の値 (`ON` など)。選択中は `< ON >` の形で左右キーで変えられることを示す */
  value?: string;
  /** 右側の段階バー (音量など) */
  bar?: { level: number; max: number };
  /** 選べない項目の右側に出す補足 (`SOON` など) */
  note?: string;
}

export interface MenuListLayout {
  x: number;
  y: number;
  width: number;
  rowHeight?: number;
}

/** メニューの項目リスト。選択中の行は地を overlay にし、左に `>` を付ける */
export function drawMenuList(
  ctx: CanvasRenderingContext2D,
  items: readonly MenuItemView[],
  selectedIndex: number,
  layout: MenuListLayout,
): void {
  const rowH = layout.rowHeight ?? 32;
  const right = layout.x + layout.width - 12;
  items.forEach((item, i) => {
    const rowY = layout.y + i * rowH;
    const textY = rowY + (rowH - 14) / 2;
    const isSelected = i === selectedIndex;
    if (isSelected) {
      ctx.fillStyle = colors.overlay;
      ctx.fillRect(layout.x, rowY, layout.width, rowH - 4);
      drawText(ctx, '>', layout.x + 8, textY - 2, { color: colors.white });
    }
    let labelColor: string = colors.text;
    if (!item.isEnabled) labelColor = colors.midGrey;
    else if (isSelected) labelColor = colors.white;
    drawText(ctx, item.label, layout.x + 28, textY - 2, { color: labelColor });

    if (item.note !== undefined) {
      drawText(ctx, item.note, right, textY - 2, { color: colors.midGrey, align: 'right' });
    }
    if (item.bar !== undefined) {
      const arrowW = isSelected ? 24 : 0;
      drawLevelBar(ctx, right - arrowW, textY - 2, item.bar.level, item.bar.max);
      if (isSelected) {
        const barW = item.bar.max * 12 - 4;
        drawText(ctx, '<', right - arrowW - barW - 12, textY - 2, { color: colors.white, align: 'right' });
        drawText(ctx, '>', right, textY - 2, { color: colors.white, align: 'right' });
      }
    }
    if (item.value !== undefined) {
      const text = isSelected ? `< ${item.value} >` : item.value;
      drawText(ctx, text, right, textY - 2, { color: isSelected ? colors.white : colors.text, align: 'right' });
    }
  });
}

/** 段階バー (1 段 8×14、間隔 4)。right は右端の x */
function drawLevelBar(ctx: CanvasRenderingContext2D, right: number, y: number, level: number, max: number): void {
  const left = right - (max * 12 - 4);
  for (let i = 0; i < max; i++) {
    ctx.fillStyle = i < level ? colors.hudGreen : colors.surface;
    ctx.fillRect(left + i * 12, y, 8, 14);
  }
}

/** 画面の見出し (4 倍文字、中央揃え) */
export function drawScreenTitle(ctx: CanvasRenderingContext2D, text: string, centerX: number, y: number): void {
  drawText(ctx, text, centerX, y, { scale: 4, color: colors.white, align: 'center' });
}

/** 画面下の操作案内 (標準文字、subtext) */
export function drawFooterHint(ctx: CanvasRenderingContext2D, text: string, centerX: number, y = 564): void {
  drawText(ctx, text, centerX, y, { color: colors.subtext, align: 'center' });
}

