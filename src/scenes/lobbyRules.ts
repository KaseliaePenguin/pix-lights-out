/** ロビーで選べる周回数 (game-design.md 6.1 節: 3 / 5) */
export const lapChoicesOnline: readonly number[] = [3, 5];

/** 他の人が使っていないチームを step の向きに探す (見つからなければ今のまま) */
export function nextFreeTeam(current: number, step: number, taken: readonly number[]): number {
  let team = current;
  for (let i = 0; i < 8; i++) {
    team = ((team - 1 + step + 8) % 8) + 1;
    if (!taken.includes(team)) return team;
  }
  return current;
}
