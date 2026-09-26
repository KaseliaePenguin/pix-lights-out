import type { CpuDifficulty } from '../shared/carParams';

/** レース設定画面で選ぶ値 (game-design.md 6.1 節。予選・スタートタイヤは M3) */
export interface RaceSetup {
  /** プレイヤーの車番 (チーム) 1〜8 */
  carNumber: number;
  /** 1〜7 */
  cpuCount: number;
  difficulty: CpuDifficulty;
  /** M2 は 3 のみ (5 は M3) */
  totalLaps: number;
}

export const defaultRaceSetup: Readonly<RaceSetup> = {
  carNumber: 1,
  cpuCount: 7,
  difficulty: 'normal',
  totalLaps: 3,
};

export const difficulties: readonly CpuDifficulty[] = ['easy', 'normal', 'hard'];
export const maxCpuCount = 7;
/** 選べる周回数 (M3 で 5 を足す) */
export const lapChoices: readonly number[] = [3];

/** 起動中だけ覚えておく (リザルトから戻ったときに同じ値で始める) */
let current: RaceSetup = { ...defaultRaceSetup };

/** 呼び出し側が書き換えてもよいよう、コピーを返す */
export function loadRaceSetup(): RaceSetup {
  return { ...current };
}

export function saveRaceSetup(setup: RaceSetup): void {
  current = { ...setup };
}

/** 新しいレースの乱数の seed (同じ seed なら同じグリッド・同じ CPU になる) */
export function newRaceSeed(): number {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}
