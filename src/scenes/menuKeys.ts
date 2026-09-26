import type { Input } from '../core/Input';

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
