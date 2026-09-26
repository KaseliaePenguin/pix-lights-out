/**
 * 前車・先頭とのタイム差 (game-design.md 7.5 節・10.1 節)。表示は src/ui/raceGap.ts の formatRaceGap。
 * - time: 秒 (正 = 相手より遅れている)
 * - laps: 周回遅れ (n 周)
 * - leader / pit / out: 先頭・ピットレーン内・リタイア
 * - none: まだ差が出ていない (スタート直後など)
 */
export type RaceGap =
  | { kind: 'time'; seconds: number }
  | { kind: 'laps'; laps: number }
  | { kind: 'leader' }
  | { kind: 'pit' }
  | { kind: 'out' }
  | { kind: 'none' };
