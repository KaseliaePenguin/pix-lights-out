/**
 * 通信で使う時計とタイマー。確認スクリプトでは仮想の時計に差し替えて、待たずに時間を進める。
 * 時刻は ms。systemClock の now は performance.timeOrigin + performance.now() (ホストでは Worker のこの値がホスト時刻)
 */
export interface NetClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: NetClock = {
  now: () => performance.timeOrigin + performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
