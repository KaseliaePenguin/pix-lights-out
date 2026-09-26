import type { TireMarks } from '../render/TireMarks';
import type { Car, WheelIndex } from '../shared/Car';
import type { Particles } from './Particles';

/** 砂利・芝の跳ねを出す最低速度 (px/秒、game-design.md 10.4 節) */
const dirtMinSpeed = 125;
const wheels: readonly WheelIndex[] = [0, 1, 2, 3];
const rearWheels: readonly WheelIndex[] = [2, 3];

/**
 * 車輪から出る演出を 1 フレーム分足す: タイヤ痕、砂利・芝の跳ね、スピン中のスモーク。
 * marks / particles の update はシーンが 1 回だけ呼ぶ。wheel は計算用の作業領域
 */
export function emitWheelEffects(car: Car, marks: TireMarks, particles: Particles, wheel: { x: number; y: number }): void {
  // タイヤ痕: skidRear で後輪 2 本、skidFront で前輪 2 本 (スピン中は Car が両方立てる)
  for (const index of wheels) {
    const isFront = index < 2;
    if (isFront ? car.skidFront : car.skidRear) {
      car.wheelPosition(index, wheel);
      marks.add(wheel.x, wheel.y);
    }
  }

  // 砂利・芝の跳ね (車輪ごと、毎フレームは多すぎるので確率で間引く)
  if (car.speed >= dirtMinSpeed) {
    for (const index of wheels) {
      const surface = car.wheelSurfaces[index];
      if ((surface === 'grass' || surface === 'gravel') && Math.random() < 0.5) {
        car.wheelPosition(index, wheel);
        particles.emitDirt(surface, wheel.x, wheel.y, car.vx, car.vy);
      }
    }
  }
  if (car.isSpinning && Math.random() < 0.6) {
    car.wheelPosition(rearWheels[Math.random() < 0.5 ? 0 : 1], wheel);
    particles.emitSmoke(wheel.x, wheel.y);
  }
}
