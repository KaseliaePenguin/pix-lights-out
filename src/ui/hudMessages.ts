import { colors } from './colors';
import { formatLapTime } from './format';
import type { HudMessage } from './MessageQueue';

/**
 * メッセージ帯の文言・色・優先度 (game-design.md 10.2 節の表)。
 * 優先度 1 のものは MessageQueue.setStatus で、状態が続く間だけ出す。
 */
export const hudMessages = {
  // 優先度 1 (状態が続く間、点滅)
  wrongWay: (): HudMessage => ({ text: 'WRONG WAY', color: colors.yellow, priority: 1 }),
  missedCheckpoint: (): HudMessage => ({ text: 'MISSED CHECKPOINT', color: colors.yellow, priority: 1 }),
  pressToReset: (isGamepad = false): HudMessage => ({
    text: isGamepad ? 'PRESS Y TO RESET' : 'PRESS R TO RESET',
    color: colors.yellow,
    priority: 1,
  }),
  // 優先度 2
  jumpStart: (): HudMessage => ({ text: 'JUMP START +3 SEC', color: colors.yellow, priority: 2 }),
  fastestLap: (abbr: string, lapTime: number): HudMessage => ({
    text: `FASTEST LAP ${abbr} ${formatLapTime(lapTime)}`,
    color: colors.hudPurple,
    priority: 2,
  }),
  newRecord: (lapTime: number): HudMessage => ({
    text: `NEW RECORD ${formatLapTime(lapTime)}`,
    color: colors.hudPurple,
    priority: 2,
  }),
  // 優先度 3
  boxBox: (): HudMessage => ({ text: 'BOX BOX', color: colors.yellow, priority: 3 }),
  blueFlag: (): HudMessage => ({ text: 'BLUE FLAG', color: colors.blue, priority: 3 }),
  invalidLap: (): HudMessage => ({ text: 'INVALID LAP', color: colors.midGrey, priority: 3 }),
  // 優先度 4
  drsEnabled: (): HudMessage => ({ text: 'DRS ENABLED', color: colors.hudGreen, priority: 4 }),
  finalLap: (): HudMessage => ({ text: 'FINAL LAP', color: colors.white, priority: 4 }),
  reaction: (seconds: number): HudMessage => ({
    text: `REACTION ${seconds.toFixed(3)}`,
    color: colors.white,
    priority: 4,
  }),
  /** コース復帰中。setStatus('reset', ...) で毎フレーム呼び直す想定 */
  resetCount: (remaining: number): HudMessage => ({
    text: `RESET ${Math.max(0, remaining).toFixed(1)}`,
    color: colors.white,
    priority: 4,
  }),
  /** 自分のゴール (最優先) */
  finish: (position: number): HudMessage => ({
    text: `P${position} FINISH`,
    color: colors.white,
    priority: 0,
    hasChecker: true,
  }),
};
