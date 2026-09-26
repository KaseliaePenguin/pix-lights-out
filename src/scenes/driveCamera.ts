import type { Camera, CameraRotation } from '../core/Camera';
import type { Car } from '../shared/Car';
import type { CameraMode } from './settingsStorage';

/** これより遅い (前進) ときはカメラをゆっくり回す (px/秒) */
const cameraSlowSpeed = 60;

/** 設定のカメラの方式 → Camera の回転の方式 */
export function cameraRotationOf(mode: CameraMode): CameraRotation {
  return mode === 'fixed' ? 'fixed' : 'smooth';
}

/** 設定のカメラの方式を反映する。回転に切り替えたときは、向きをすぐに車に合わせる */
export function applyCameraMode(camera: Camera, mode: CameraMode, car: Car | null): void {
  const before = camera.rotation;
  camera.rotation = cameraRotationOf(mode);
  if (car && before === 'fixed' && camera.rotation !== 'fixed') camera.snapTo(car.x, car.y, car.heading);
}

/** カメラを 1 フレーム分動かす。回転するときは進行方向 (滑り角を含まない向き) を少し遅れて追う */
export function followCar(camera: Camera, car: Car, dt: number): void {
  if (camera.rotation === 'fixed') {
    camera.update(dt, car.x, car.y, car.vx, car.vy);
    return;
  }
  // スピン中・後退中は向きを止め、ごく低速ではゆっくり回す (向きが急に振れて酔わないように)
  const hold = car.isSpinning || car.isReversing ? 'freeze' : car.sF < cameraSlowSpeed ? 'slow' : 'none';
  camera.updateRotating(dt, car.x, car.y, car.heading, car.sF, hold);
}
