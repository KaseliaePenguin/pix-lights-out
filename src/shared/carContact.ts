import type { Car } from './Car';

/**
 * 車同士の接触 (car-physics.md 9.1 節)。当たり判定は向き付きの長方形 (18×38) 同士の分離軸判定 (SAT)。
 * DOM に依存しない。1 人用 (全車をこの端末で計算) では両方を押し戻す。マルチでは自車だけを動かす (M4)。
 */

export interface ContactResult {
  /** めり込み量 (px) と、A から B へ向かう法線 */
  depth: number;
  nx: number;
  ny: number;
  /** 接触点の目安 (2 台の中心の中点) */
  x: number;
  y: number;
}

/** 衝撃の結果 (演出用)。impact が 0 なら押し戻しだけ */
export interface ContactOutcome {
  impact: number;
  /** 当てた側 (両方なら両方 true) */
  isAAttacker: boolean;
  isBAttacker: boolean;
  spinA: boolean;
  spinB: boolean;
  /**
   * B (相手) の速度の変化 (px/秒) と、B が回る向き (+1 = 時計回り、回らなければ 0)。
   * pushBoth が false (マルチ) のときも計算する。相手の端末に collision で伝える値
   */
  dvBx: number;
  dvBy: number;
  spinDirB: number;
}

/** ContactOutcome の入れ物を作る (使い回す) */
export function createContactOutcome(): ContactOutcome {
  return { impact: 0, isAAttacker: false, isBAttacker: false, spinA: false, spinB: false, dvBx: 0, dvBy: 0, spinDirB: 0 };
}

const tmpAxes = new Float64Array(8);

/** 2 台の当たり判定が重なっていれば、めり込みと法線を返す。重なっていなければ null */
export function detectContact(a: Car, b: Car, out: ContactResult): ContactResult | null {
  const pa = a.params;
  const hwA = pa.hitWidth / 2;
  const hlA = pa.hitLength / 2;
  const pb = b.params;
  const hwB = pb.hitWidth / 2;
  const hlB = pb.hitLength / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // 大まかな距離で早めに除外する
  const reach = Math.hypot(hwA, hlA) + Math.hypot(hwB, hlB);
  if (dx * dx + dy * dy > reach * reach) return null;

  const afx = Math.sin(a.heading), afy = -Math.cos(a.heading);
  const bfx = Math.sin(b.heading), bfy = -Math.cos(b.heading);
  // 軸: A の前・右、B の前・右
  tmpAxes[0] = afx; tmpAxes[1] = afy;
  tmpAxes[2] = -afy; tmpAxes[3] = afx;
  tmpAxes[4] = bfx; tmpAxes[5] = bfy;
  tmpAxes[6] = -bfy; tmpAxes[7] = bfx;
  let minDepth = Infinity;
  let nx = 0;
  let ny = 0;
  for (let k = 0; k < 4; k++) {
    const ax = tmpAxes[k * 2];
    const ay = tmpAxes[k * 2 + 1];
    const rA = hlA * Math.abs(afx * ax + afy * ay) + hwA * Math.abs(-afy * ax + afx * ay);
    const rB = hlB * Math.abs(bfx * ax + bfy * ay) + hwB * Math.abs(-bfy * ax + bfx * ay);
    const dist = dx * ax + dy * ay;
    const overlap = rA + rB - Math.abs(dist);
    if (overlap <= 0) return null;
    if (overlap < minDepth) {
      minDepth = overlap;
      const sign = dist >= 0 ? 1 : -1;
      nx = ax * sign;
      ny = ay * sign;
    }
  }
  out.depth = minDepth;
  out.nx = nx;
  out.ny = ny;
  out.x = (a.x + b.x) / 2;
  out.y = (a.y + b.y) / 2;
  return out;
}

/**
 * 接触を解く。applyImpulse が false (同じ 2 台の 0.2 秒以内の再接触) なら押し戻しだけ行う。
 * pushBoth が false なら A (自車) だけを押し戻し、速度・スピンも A にだけ適用する (マルチ用)
 */
export function resolveContact(a: Car, b: Car, c: ContactResult, applyImpulse: boolean, pushBoth: boolean, out: ContactOutcome): ContactOutcome {
  const p = a.params;
  out.impact = 0;
  out.isAAttacker = false;
  out.isBAttacker = false;
  out.spinA = false;
  out.spinB = false;
  out.dvBx = 0;
  out.dvBy = 0;
  out.spinDirB = 0;

  // 1. 押し戻し
  const push = pushBoth ? c.depth / 2 + 0.05 : c.depth + 0.05;
  a.pushBy(-c.nx * push, -c.ny * push);
  if (pushBoth) b.pushBy(c.nx * push, c.ny * push);
  if (!applyImpulse) return out;

  const vax = a.vx, vay = a.vy, vbx = b.vx, vby = b.vy;
  const j = Math.max(0, (vax - vbx) * c.nx + (vay - vby) * c.ny);
  if (j <= 0) return out;
  out.impact = j;
  const cA = vax * c.nx + vay * c.ny;
  const cB = -(vbx * c.nx + vby * c.ny);
  const sFA = a.sF;
  const sFB = b.sF;

  // 2. 反発 (質量は同じ)
  const k = ((1 + p.restitution) / 2) * j;
  let nvax = vax - k * c.nx;
  let nvay = vay - k * c.ny;
  let nvbx = vbx + k * c.nx;
  let nvby = vby + k * c.ny;

  // 3. 当てた側 (接近速度の差が attackerMargin 以内なら両方)
  const isA = cA - cB > p.attackerMargin || Math.abs(cA - cB) <= p.attackerMargin;
  const isB = cB - cA > p.attackerMargin || Math.abs(cA - cB) <= p.attackerMargin;
  out.isAAttacker = isA;
  out.isBAttacker = isB;

  // 4. 当てた側への追加の減速 (体当たりを損にする)
  const loss = 1 - Math.min(p.attackerLossMax, j / p.attackerLossDiv);
  if (isA) {
    nvax *= loss;
    nvay *= loss;
  }
  if (isB) {
    nvbx *= loss;
    nvby *= loss;
  }

  // 5. 当てられた側は押されても速くならない (前方向の速度を接触前より上げない)
  if (!isA) [nvax, nvay] = capForward(a, nvax, nvay, sFA);
  if (!isB) [nvbx, nvby] = capForward(b, nvbx, nvby, sFB);

  // マルチでは相手の車は相手の端末が動かす (car-physics.md 9.1 節の collision メッセージ)
  out.dvBx = nvbx - vbx;
  out.dvBy = nvby - vby;
  a.applyContactVelocity(nvax, nvay);
  if (pushBoth) b.applyContactVelocity(nvbx, nvby);

  // 6. スピン: 当てた側は J が閾値以上で回る。当てられた側は横から当てられたときだけ
  if (j >= p.spinImpulseCar) {
    const sideA = sideOf(a, b);
    const sideB = sideOf(b, a);
    const lateralA = Math.abs(c.nx * Math.cos(a.heading) + c.ny * Math.sin(a.heading)) > 0.7;
    const lateralB = Math.abs(c.nx * Math.cos(b.heading) + c.ny * Math.sin(b.heading)) > 0.7;
    if (isA || lateralA) {
      a.startContactSpin(sideA > 0 ? -1 : 1);
      out.spinA = true;
    }
    if (isB || lateralB) {
      out.spinB = true;
      out.spinDirB = sideB > 0 ? -1 : 1;
      if (pushBoth) b.startContactSpin(out.spinDirB);
    }
  }
  return out;
}

/** 相手が自分の右側なら正 (衝撃が右側 → 反時計回りに回す) */
function sideOf(self: Car, other: Car): number {
  return (other.x - self.x) * Math.cos(self.heading) + (other.y - self.y) * Math.sin(self.heading);
}

function capForward(car: Car, vx: number, vy: number, sFBefore: number): [number, number] {
  const fx = Math.sin(car.heading);
  const fy = -Math.cos(car.heading);
  const sF = vx * fx + vy * fy;
  if (sF <= sFBefore) return [vx, vy];
  const excess = sF - Math.max(0, sFBefore);
  return [vx - fx * excess, vy - fy * excess];
}
