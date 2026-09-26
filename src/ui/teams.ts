import { teamColors } from './colors';

/** チーム (game-design.md 4.1 節の仮名)。車番 = チーム番号 1〜8 */
export interface TeamInfo {
  readonly carNumber: number;
  readonly name: string;
  /** 3 文字の略称 */
  readonly abbr: string;
  readonly color: string;
}

const teamNames: ReadonlyArray<readonly [string, string]> = [
  ['BLAZE RACING', 'BLZ'],
  ['TANGERINE MOTORSPORT', 'TNG'],
  ['VOLT RACING', 'VLT'],
  ['VERDANT RACING', 'VRD'],
  ['AQUA DYNAMICS', 'AQD'],
  ['COBALT SPEED', 'CBT'],
  ['NOVA ROSE RACING', 'NVR'],
  ['FROST ENGINEERING', 'FRS'],
];

export const teams: readonly TeamInfo[] = teamNames.map(([name, abbr], i) => ({
  carNumber: i + 1,
  name,
  abbr,
  color: teamColors[i + 1],
}));

/** 車番 1〜8 のチーム。範囲外は 1 として扱う */
export function teamOf(carNumber: number): TeamInfo {
  return teams[Math.min(Math.max(Math.round(carNumber), 1), teams.length) - 1];
}

/** 順位表・名前タグ・リザルトに出す 3 文字 (1 人用ではプレイヤーは `YOU`、4.1 節) */
export function displayAbbr(carNumber: number, isPlayer: boolean): string {
  return isPlayer ? 'YOU' : teamOf(carNumber).abbr;
}
