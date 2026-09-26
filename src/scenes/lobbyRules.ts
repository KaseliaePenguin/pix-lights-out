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

/**
 * 名前が重なって断られたときに入り直す名前。末尾に 2, 3, … を付ける (8 文字を超えるぶんは元の名前の後ろを削る)。
 * attempt は 0 から数える。元の名前と同じになる番号は飛ばす
 */
export function alternativeName(name: string, attempt: number): string {
  let n = 2 + attempt;
  for (;;) {
    const suffix = String(n);
    const candidate = name.slice(0, 8 - suffix.length) + suffix;
    if (candidate !== name) return candidate;
    n++;
  }
}
