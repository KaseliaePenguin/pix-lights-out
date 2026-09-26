import type { Car } from './Car';
import { wrapAngle } from './math';

/**
 * スリップストリームの条件 (car-physics.md 11 節)。follower (M) が leader (L) の後ろで効くか。
 * ゴーストの関係かどうかは呼び出し側で除く
 */
export function isInSlipstream(follower: Car, leader: Car): boolean {
  const p = follower.params;
  if (follower.sF < p.slipMinSpeed) return false;
  const lfx = Math.sin(leader.heading);
  const lfy = -Math.cos(leader.heading);
  // L の後端からの距離
  const rx = leader.x - lfx * p.slipRearOffset;
  const ry = leader.y - lfy * p.slipRearOffset;
  const ddx = follower.x - rx;
  const ddy = follower.y - ry;
  if (ddx * ddx + ddy * ddy > p.slipRange * p.slipRange) return false;
  // (M − L) の向きと L の真後ろの向きのなす角
  const mx = follower.x - leader.x;
  const my = follower.y - leader.y;
  const len = Math.hypot(mx, my);
  if (len < 1e-6) return false;
  const cos = -(mx * lfx + my * lfy) / len;
  if (cos < Math.cos(p.slipAngle)) return false;
  return Math.abs(wrapAngle(follower.heading - leader.heading)) <= p.slipHeading;
}
