import type { Game } from '../core/Game';
import type { Input } from '../core/Input';
import type { MenuListLayout } from '../ui/menuList';
import { backButtonRect, fullscreenButtonRect, menuRowRect, menuValueRect } from '../ui/touchUi';

// メニュー操作のキー (game-design.md 5.1 節: 上下で選択、Enter / Space で決定、Escape で戻る)
// TODO(gamepad): M3 でゲームパッド (十字キー・A・B) を足す

export function wasMenuUpPressed(input: Input): boolean {
  return input.wasPressed('ArrowUp') || input.wasPressed('KeyW');
}

export function wasMenuDownPressed(input: Input): boolean {
  return input.wasPressed('ArrowDown') || input.wasPressed('KeyS');
}

export function wasMenuLeftPressed(input: Input): boolean {
  return input.wasPressed('ArrowLeft') || input.wasPressed('KeyA');
}

export function wasMenuRightPressed(input: Input): boolean {
  return input.wasPressed('ArrowRight') || input.wasPressed('KeyD');
}

export function wasMenuConfirmPressed(input: Input): boolean {
  return input.wasPressed('Enter') || input.wasPressed('Space');
}

/**
 * 走行の直後に出る画面 (リザルト、切断のダイアログ) の決定。Space は走行中に DRS で押しているので使わない
 */
export function wasAfterRaceConfirmPressed(input: Input): boolean {
  return input.wasPressed('Enter') || input.wasPressed('NumpadEnter');
}

/** 走行の直後に出る画面が入力を受け付けるまでの時間 (秒)。走行中に押していたキーで読まずに進まないように */
export const afterRaceInputDelay = 1;

export function wasMenuBackPressed(input: Input): boolean {
  return input.wasPressed('Escape');
}

/**
 * 選べる項目だけを上下に移動する (端で折り返す)。選べる項目がなければ現在位置のまま。
 * isSelectable を省くと全項目を選べるものとして扱う
 */
export function moveMenuCursor(
  current: number,
  step: number,
  count: number,
  isSelectable: (index: number) => boolean = () => true,
): number {
  let index = current;
  for (let i = 0; i < count; i++) {
    index = (index + step + count) % count;
    if (isSelectable(index)) return index;
  }
  return current;
}

// ---- タッチ (game-design.md 5.4 節)。タップはマウスのクリックでも同じように効く ----

/** タップした行 (なければ -1) */
export function tappedMenuRow(game: Game, layout: MenuListLayout, count: number): number {
  const tap = game.pointer.tap;
  if (!tap) return -1;
  for (let i = 0; i < count; i++) if (game.pointer.wasTappedIn(menuRowRect(layout, i))) return i;
  return -1;
}

/** index 行目の値の側をタップしたら、左半分で -1・右半分で 1。それ以外は 0 */
export function tappedMenuValueStep(game: Game, layout: MenuListLayout, index: number): number {
  const tap = game.pointer.tap;
  const r = menuValueRect(layout, index);
  if (!tap || !game.pointer.wasTappedIn(r)) return 0;
  return tap.x < r.x + r.w / 2 ? -1 : 1;
}

/** 画面左上の BACK をタップしたか (タッチの端末でボタンを出しているときだけ) */
export function wasBackTapped(game: Game): boolean {
  return game.pointer.isTouchMode && game.pointer.wasTappedIn(backButtonRect);
}

/** 全画面のボタンを出すか (タッチの端末で、全画面にできるとき) */
export function isFullscreenButtonShown(game: Game): boolean {
  return game.pointer.isTouchMode && game.screen.canFullscreen;
}

/** 全画面のボタンをタップしたら切り替えて true */
export function handleFullscreenTap(game: Game): boolean {
  if (!isFullscreenButtonShown(game) || !game.pointer.wasTappedIn(fullscreenButtonRect)) return false;
  game.audio.playSe('ui-confirm');
  game.screen.toggleFullscreen();
  return true;
}

/** 画面下の操作案内。タッチの端末ではタップの案内にする */
export function menuHint(game: Game, keyboardText: string, touchText = 'TAP AN ITEM TO SELECT'): string {
  return game.pointer.isTouchMode ? touchText : keyboardText;
}
