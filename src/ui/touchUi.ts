import type { OverlayRect } from './DomOverlay';
import { drawButton } from './lobbyList';
import { drawMenuList } from './menuList';
import type { MenuItemView, MenuListLayout } from './menuList';

// タッチの端末だけに出す、Canvas の中のボタン (game-design.md 5.4 節)。位置は Canvas の座標 (800×600)

/** 画面左上の BACK (Esc の代わり) */
export const backButtonRect: OverlayRect = { x: 12, y: 12, w: 104, h: 36 };

/** 画面右上の全画面ボタン */
export const fullscreenButtonRect: OverlayRect = { x: 800 - 12 - 172, y: 12, w: 172, h: 36 };

export function drawBackButton(ctx: CanvasRenderingContext2D): void {
  drawButton(ctx, backButtonRect, '< BACK');
}

export function drawFullscreenButton(ctx: CanvasRenderingContext2D, isFullscreen: boolean): void {
  drawButton(ctx, fullscreenButtonRect, isFullscreen ? 'EXIT FULL' : 'FULL SCREEN');
}

/** メニューの index 行目の、タップで押せる範囲 (drawMenuList の行と同じ) */
export function menuRowRect(layout: MenuListLayout, index: number): OverlayRect {
  const rowH = layout.rowHeight ?? 32;
  return { x: layout.x, y: layout.y + index * rowH, w: layout.width, h: rowH };
}

/**
 * 値を左右で変える行 (設定など) の、値の側 (右 45%)。左半分をタップで前の値、右半分で次の値。
 * 行のそれ以外の場所のタップは、キーボードの決定と同じ
 */
export function menuValueRect(layout: MenuListLayout, index: number): OverlayRect {
  const row = menuRowRect(layout, index);
  const w = Math.round(row.w * 0.45);
  return { x: row.x + row.w - w, y: row.y, w, h: row.h };
}

/** タッチの端末では、値を変えられる行は選んでいなくても `< >` を出す (タップで変えられることを見せる) */
export function drawTouchMenuList(
  ctx: CanvasRenderingContext2D,
  items: readonly MenuItemView[],
  selectedIndex: number,
  layout: MenuListLayout,
  isTouchMode: boolean,
): void {
  if (!isTouchMode) {
    drawMenuList(ctx, items, selectedIndex, layout);
    return;
  }
  const views = items.map((item, i) => (i !== selectedIndex && item.value !== undefined ? { ...item, value: `< ${item.value} >` } : item));
  drawMenuList(ctx, views, selectedIndex, layout);
}
