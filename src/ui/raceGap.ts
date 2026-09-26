import type { RaceGap } from '../shared/raceGap';
import { formatLapTime } from './format';

/** 型は src/shared/raceGap.ts (レースのセッションが作る) */
export type { RaceGap };

/**
 * 差を最大 7 文字にする (順位表の差の欄 x86-170 に収まる幅)。
 * 1 分未満は `+1.234`、1 分以上は仕様の `+1:02.345` では入らないので `+1:02.3` に縮める
 */
export function formatRaceGap(gap: RaceGap, sign: '+' | '-' = '+'): string {
  switch (gap.kind) {
    case 'leader':
      return 'LEADER';
    case 'pit':
      return 'PIT';
    case 'out':
      return 'OUT';
    case 'none':
      return '-';
    case 'laps':
      return `${sign}${gap.laps} LAP`;
    case 'time': {
      const s = Math.abs(gap.seconds);
      if (s < 60) {
        const ms = Math.floor(s * 1000 + 1e-6);
        return `${sign}${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}`;
      }
      return `${sign}${formatLapTime(s).slice(0, -2)}`;
    }
  }
}
