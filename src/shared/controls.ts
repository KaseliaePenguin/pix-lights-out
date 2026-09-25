/**
 * 車への入力 (game-design.md 5.3 節、car-physics.md 2.3 節)。
 * キーボード・ゲームパッド・AI・ネットワークはすべてこの形を作る側として実装する。
 */
export interface Controls {
  /** アクセル 0〜1 */
  throttle: number;
  /** ブレーキ / 後退 0〜1 */
  brake: number;
  /** ステア -1 (左)〜1 (右) */
  steerInput: number;
  /** アナログ入力なら true (平滑化しない) */
  steerIsAnalog: boolean;
  /** DRS ボタンを押した瞬間 */
  drsPressed: boolean;
  /** コース復帰ボタンを押した瞬間 */
  resetPressed: boolean;
}

export function createControls(): Controls {
  return { throttle: 0, brake: 0, steerInput: 0, steerIsAnalog: false, drsPressed: false, resetPressed: false };
}

export function clearControls(out: Controls): Controls {
  out.throttle = 0;
  out.brake = 0;
  out.steerInput = 0;
  out.steerIsAnalog = false;
  out.drsPressed = false;
  out.resetPressed = false;
  return out;
}

export function copyControls(from: Controls, to: Controls): Controls {
  to.throttle = from.throttle;
  to.brake = from.brake;
  to.steerInput = from.steerInput;
  to.steerIsAnalog = from.steerIsAnalog;
  to.drsPressed = from.drsPressed;
  to.resetPressed = from.resetPressed;
  return to;
}
