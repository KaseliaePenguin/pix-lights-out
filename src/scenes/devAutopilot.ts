import type { NetRaceClient } from '../net/NetRaceClient';
import { carParams } from '../shared/carParams';
import type { Controls } from '../shared/controls';
import { CpuDriver, createCpuSurroundings } from '../shared/CpuDriver';
import { Random } from '../shared/Random';
import { getCourseRacingLine, getCourseTrack } from './courseCache';

/**
 * 開発用: オンラインの決勝で自車を CPU に運転させる (?autopilot=1。ヘッドレスの 2 タブ確認でレースを最後まで進めるため)。
 * scripts/sim-net.mjs の driveStep と同じ手順。本番ビルドでは使わない
 */
export class DevAutopilot {
  private readonly driver: CpuDriver;
  private readonly env = createCpuSurroundings(8);

  constructor(seed: number) {
    this.driver = new CpuDriver(getCourseRacingLine(), getCourseTrack(), 'normal', new Random(seed), carParams.compoundGrip.soft);
  }

  static isEnabled(): boolean {
    return import.meta.env.DEV && new URLSearchParams(location.search).get('autopilot') === '1';
  }

  drive(race: NetRaceClient, dt: number, out: Controls): void {
    const self = race.player;
    const env = this.env;
    let n = 0;
    for (const rc of race.cars) if (rc !== self && race.isOnTrack(rc) && !race.isGhostPair(self.index, rc.index)) env.others[n++] = rc.car;
    env.othersCount = n;
    env.canDrive = race.phase === 'racing' && self.status !== 'retired';
    env.timeSinceStart = race.time - race.lightsOutAt;
    env.wantsReset = self.lap.isWrongWay || self.lap.isCheckpointMissed;
    this.driver.update(self.car, env, dt, out);
  }

  resetTracking(): void {
    this.driver.resetTracking();
  }
}
