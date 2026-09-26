import type { CarParams, SurfaceKind, TyreCompound } from './carParams';
import { carParams, tyreGrip } from './carParams';
import type { Controls } from './controls';
import { approach, clamp, wrapAngle } from './math';
import type { Pose, WallContact } from './Track';

/** 車が走る環境 (Track が満たす)。テスト用に差し替えられるようにインターフェースにしておく */
export interface CarEnvironment {
  surfaceAt(x: number, y: number): SurfaceKind;
  wallContact(x: number, y: number, out: WallContact): WallContact;
}

/** 車輪の番号: 0 = 左前、1 = 右前、2 = 左後、3 = 右後 */
export type WheelIndex = 0 | 1 | 2 | 3;

/** grip = グリップ走行、spin = スピン (操作不能) */
export type CarMode = 'grip' | 'spin';

// 当たり判定の外周の点 (車の座標系: 右 = +x、前 = +y)。長方形 18×38 の角と辺の途中
const outlineLocal: readonly (readonly [number, number])[] = [
  [-9, 19], [9, 19], [-9, -19], [9, -19],
  [-9, 9.5], [9, 9.5], [-9, 0], [9, 0], [-9, -9.5], [9, -9.5],
  [0, 19], [0, -19],
];


/**
 * 車 1 台の物理 (car-physics.md 第 4 版からドリフト・ERS ブーストを除いたもの)。DOM に依存しない。
 * 毎フレーム update(controls, dt) を呼ぶ。パラメータは params (既定は carParams) を毎フレーム読むので、
 * 調整パネルで carParams を書き換えると次のフレームから効く。
 * スリップストリーム (fSlip)・タイヤ摩耗・車同士の接触は M2 以降。
 */
export class Car {
  // --- 状態 (2.3 節) ---
  x = 0;
  y = 0;
  /** 車体の向き θ (0 = 北、時計回りが正) */
  heading = 0;
  /** 車体から見た前方向・右方向の速度 */
  sF = 0;
  sR = 0;
  mode: CarMode = 'grip';
  steer = 0;
  fSlip = 0;
  fDrs = 0;
  compound: TyreCompound = 'soft';
  wear = 0;
  spinTimer = 0;
  drsOpen = false;
  /** この位置で DRS を開けるか (DrsController が毎フレーム決める) */
  drsAvailable = false;
  /** true の間は Controls を無視する (カウントダウン・コース復帰中など) */
  controlLocked = false;
  /** 速度の上限 (ピットレーンなど)。通常は Infinity */
  speedLimit = Infinity;

  /** 直前の update の開始時の位置 (ゲートの通過判定に使う) */
  prevX = 0;
  prevY = 0;

  // --- 演出・HUD・デバッグ用の値 (update ごとに更新) ---
  /** グリップ使用率 uReq (grip モード。1 を超えると限界超え) */
  uReq = 0;
  /** 横グリップの倍率 G */
  grip = 1;
  /** ブレーキのグリップ倍率 Gbrake */
  brakeGrip = 1;
  /** 実際の旋回速度 (rad/秒、車体の向きの変化) */
  yawRate = 0;
  /** 限界超えによる減速 (px/秒²) */
  scrubDecel = 0;
  /** 各車輪の路面 (WheelIndex の順) */
  readonly wheelSurfaces: SurfaceKind[] = ['asphalt', 'asphalt', 'asphalt', 'asphalt'];
  /** コース外 (芝生・砂利) にある車輪の数 */
  wheelsOffTrack = 0;
  /** 縁石に乗っている車輪の数 */
  wheelsOnKerb = 0;
  /** 描画用の向き (grip では滑り角を足したもの。spin では車体の向きそのもの) */
  drawHeading = 0;
  /** スキール音の目標の音量 0〜1 と再生速度 (16 節)。フェードは音の側で行う */
  squealVolume = 0;
  squealRate = 1;
  /** タイヤ痕を出すか: 後輪・前輪 */
  skidRear = false;
  skidFront = false;
  /** このフレームでフルブレーキのタイヤ痕が始まった (tire-lockup を 1 回鳴らす) */
  lockupStarted = false;
  /** このフレームの壁との衝撃の強さ J (px/秒、0 なら衝突なし) と接触点 */
  wallImpact = 0;
  wallImpactX = 0;
  wallImpactY = 0;
  /** 壁に接して擦っている (scrape-loop 用) */
  isScraping = false;
  /** このフレームでスピンが始まった */
  spinStarted = false;
  /** このフレームで DRS が開いた / 閉じた */
  drsOpened = false;
  drsClosed = false;
  /** 後退モード中 */
  isReversing = false;

  private reverseHold = 0;
  private fullBrakeTime = 0;
  private spinDuration = 1;
  private spinRate0 = 0;
  private spinDecelNow = 0;
  private spinVx = 0;
  private spinVy = 0;
  private isUpdating = false;
  private closedOutsideUpdate = false;
  private readonly contact: WallContact = { depth: 0, normalX: 0, normalY: 0 };

  constructor(private readonly env: CarEnvironment, readonly params: Readonly<CarParams> = carParams) {}

  /** 速さ (px/秒、向きなし) */
  get speed(): number {
    if (this.spinTimer > 0) return Math.hypot(this.spinVx, this.spinVy);
    return Math.hypot(this.sF, this.sR);
  }

  get isSpinning(): boolean {
    return this.spinTimer > 0;
  }

  /** 速度ベクトル */
  get vx(): number {
    if (this.spinTimer > 0) return this.spinVx;
    return Math.sin(this.heading) * this.sF + Math.cos(this.heading) * this.sR;
  }

  get vy(): number {
    if (this.spinTimer > 0) return this.spinVy;
    return -Math.cos(this.heading) * this.sF + Math.sin(this.heading) * this.sR;
  }

  /** 位置・向きを置き直し、速度などを 0 にする (スタート・コース復帰) */
  placeAt(pose: Pose): void {
    this.x = pose.x;
    this.y = pose.y;
    this.prevX = pose.x;
    this.prevY = pose.y;
    this.heading = pose.heading;
    this.drawHeading = pose.heading;
    this.sF = 0;
    this.sR = 0;
    this.steer = 0;
    this.fDrs = 0;
    this.drsOpen = false;
    this.spinTimer = 0;
    this.mode = 'grip';
    this.isReversing = false;
    this.reverseHold = 0;
    this.fullBrakeTime = 0;
    this.uReq = 0;
    this.yawRate = 0;
    this.squealVolume = 0;
    this.closedOutsideUpdate = false;
  }

  /**
   * DRS を閉じる (区間の終わりなど、外から閉じるとき)。update の前に呼ばれた場合も、
   * 次の update の drsClosed に確実に出るように、閉じたことを持ち越す
   */
  closeDrs(): void {
    if (!this.drsOpen) return;
    this.drsOpen = false;
    if (this.isUpdating) this.drsClosed = true;
    else this.closedOutsideUpdate = true;
  }

  /** 車輪の位置 (ワールド座標) */
  wheelPosition(index: WheelIndex, out: { x: number; y: number }): { x: number; y: number } {
    const p = this.params;
    const side = index % 2 === 0 ? -p.wheelSide : p.wheelSide;
    const along = index < 2 ? p.wheelFront : -p.wheelRear;
    return this.localToWorld(side, along, out);
  }

  /** 車の座標系 (右 = +x、前 = +y) からワールド座標へ */
  localToWorld(lx: number, ly: number, out: { x: number; y: number }): { x: number; y: number } {
    const s = Math.sin(this.heading);
    const c = Math.cos(this.heading);
    out.x = this.x + c * lx + s * ly;
    out.y = this.y + s * lx - c * ly;
    return out;
  }

  update(controls: Controls, dt: number): void {
    const p = this.params;
    this.prevX = this.x;
    this.prevY = this.y;
    this.wallImpact = 0;
    this.isScraping = false;
    this.lockupStarted = false;
    this.spinStarted = false;
    this.drsOpened = false;
    this.drsClosed = this.closedOutsideUpdate;
    this.closedOutsideUpdate = false;
    this.isUpdating = true;

    // 1. 入力 (スピン中・操作不能中は無視する。ブレーキ優先)
    const active = !this.controlLocked && this.spinTimer <= 0;
    let throttle = active ? clamp(controls.throttle, 0, 1) : 0;
    const brake = active ? clamp(controls.brake, 0, 1) : 0;
    if (brake > 0) throttle = 0;
    const steerInput = active ? clamp(controls.steerInput, -1, 1) : 0;

    // 2. ステアの平滑化 (4 節)
    if (active && controls.steerIsAnalog) this.steer = steerInput;
    else if (this.steer !== 0 && Math.sign(steerInput) !== Math.sign(this.steer)) this.steer = approach(this.steer, 0, p.steerReturn * dt);
    else if (Math.abs(steerInput) > Math.abs(this.steer)) this.steer = approach(this.steer, steerInput, p.steerRise * dt);
    else this.steer = approach(this.steer, steerInput, p.steerReturn * dt);

    // 3. 車輪の路面 (10 節)
    let gripSum = 0;
    let brakeSum = 0;
    let accelSum = 0;
    let surfaceDecel = 0;
    this.wheelsOffTrack = 0;
    this.wheelsOnKerb = 0;
    const speedNow = Math.abs(this.sF);
    for (let i = 0; i < 4; i++) {
      this.wheelPosition(i as WheelIndex, tmpPoint);
      const kind = this.env.surfaceAt(tmpPoint.x, tmpPoint.y);
      this.wheelSurfaces[i] = kind;
      const sp = p.surfaces[kind];
      gripSum += sp.grip;
      brakeSum += sp.brake;
      accelSum += sp.accel;
      if (speedNow > sp.speedCap) surfaceDecel += 0.25 * sp.capDecel;
      if (sp.isOffTrack) this.wheelsOffTrack++;
      if (kind === 'kerb') this.wheelsOnKerb++;
    }
    const surfaceGrip = gripSum / 4;
    const surfaceAccel = accelSum / 4;

    // 4. グリップ倍率と最高速 (5・6 節)
    const tyre = tyreGrip(p, this.compound, this.wear);
    const drsGrip = 1 - (1 - p.drsGripMul) * this.fDrs;
    this.grip = tyre * surfaceGrip * (1 - p.brakeGripLoss * brake) * drsGrip;
    this.brakeGrip = tyre * (brakeSum / 4);
    const bonus = Math.min(p.bonusCap, p.slipBonus * this.fSlip + p.drsBonus * this.fDrs);
    const vEff = Math.min(p.vBase * (1 + bonus), this.speedLimit);

    // 5. モードごとの更新
    if (this.spinTimer > 0) this.updateSpin(dt);
    else this.updateGrip(throttle, brake, controls, surfaceAccel, surfaceDecel, surfaceGrip, vEff, active, dt);

    // 9. 壁との衝突 (11.2 節)
    this.resolveWalls(dt);

    // 14 節: DRS (開くのは区間内でボタンを押したとき。閉じるのはブレーキ・スピン)
    if (this.drsOpen && (brake > 0 || this.spinTimer > 0)) this.closeDrs();
    else if (!this.drsOpen && active && this.drsAvailable && controls.drsPressed) {
      this.drsOpen = true;
      this.drsOpened = true;
    }
    this.fDrs = approach(this.fDrs, this.drsOpen ? 1 : 0, p.drsRate * dt);

    // 12. 演出の判定 (16 節)
    this.updateEffects(brake, dt);
    this.isUpdating = false;
  }

  // ------------------------------------------------------------------
  // grip モード (5・6 節)

  private updateGrip(
    throttle: number, brake: number, controls: Controls, surfaceAccel: number, surfaceDecel: number,
    surfaceGrip: number, vEff: number, active: boolean, dt: number,
  ): void {
    const p = this.params;
    // 旋回 (6.2 節)
    const s = Math.abs(this.sF);
    const yawLimit = s > 0 ? Math.min(p.yawMaxLow * Math.min(1, s / p.yawRampSpeed), (p.latGrip * p.steerDemand) / s) : 0;
    const yawCmd = this.steer * yawLimit * (this.sF >= 0 ? 1 : -1);
    const aLatMax = p.latGrip * this.grip;
    const aReq = s * Math.abs(yawCmd);
    this.uReq = aLatMax > 0 ? aReq / aLatMax : 0;
    const yaw = this.uReq > 1 ? yawCmd / Math.pow(this.uReq, p.understeerSoftness) : yawCmd;
    this.yawRate = yaw;
    this.heading += yaw * dt;

    // 前後方向 (5 節)
    this.scrubDecel = this.uReq > 1 ? Math.min(p.scrubMax, p.scrubRate * (aReq - aLatMax)) : 0;
    this.updateLongitudinal(throttle, brake, controls, surfaceAccel, surfaceDecel, vEff, active, dt);

    // 横方向の残り速度 (6.4 節)
    this.sR = approach(this.sR, 0, p.lateralDecay * surfaceGrip * dt);

    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  private updateLongitudinal(
    throttle: number, brake: number, controls: Controls, surfaceAccel: number, surfaceDecel: number,
    vEff: number, active: boolean, dt: number,
  ): void {
    const p = this.params;
    // 後退モードに入る: ほぼ止まった状態でブレーキだけを押し続ける (5.4 節)
    if (!this.isReversing) {
      if (active && brake > 0 && controls.throttle <= 0 && this.sF <= p.reverseEnterSpeed) {
        this.reverseHold += dt;
        if (this.reverseHold >= p.reverseDelay) {
          this.isReversing = true;
          this.reverseHold = 0;
        }
      } else {
        this.reverseHold = 0;
      }
    }

    if (this.isReversing) {
      const rawThrottle = active ? clamp(controls.throttle, 0, 1) : 0;
      if (rawThrottle > 0) {
        // 後退中のアクセルは後退を止めるブレーキ
        this.sF = approach(this.sF, 0, rawThrottle * p.brakeDecel * this.brakeGrip * dt);
      } else if (brake > 0) {
        this.sF = Math.max(-p.reverseMax, this.sF - brake * p.reverseAccel * dt);
      } else {
        this.sF = approach(this.sF, 0, p.coastBase * dt);
      }
      if (this.sF > 0) this.sF = 0;
      if (this.sF === 0 && brake <= 0) this.isReversing = false;
      return;
    }

    const s = Math.max(this.sF, 0);
    const ratio = s / vEff;
    const aEngine = throttle * p.accel0 * surfaceAccel * (1 - ratio * ratio);
    const aBrake = brake * p.brakeDecel * this.brakeGrip;
    const coastRatio = s / p.vBase;
    const aCoast = (1 - throttle) * (p.coastBase + p.coastDrag * coastRatio * coastRatio);
    const resist = aBrake + aCoast + this.scrubDecel + surfaceDecel;
    this.sF += aEngine * dt;
    // 抵抗は 0 をまたがない (後退には後退の操作でのみ入る)
    this.sF = approach(this.sF, 0, resist * dt);
  }

  // ------------------------------------------------------------------
  // spin モード (9 節)

  private updateSpin(dt: number): void {
    this.spinTimer = Math.max(0, this.spinTimer - dt);
    const rate = this.spinRate0 * (this.spinTimer / this.spinDuration);
    this.heading += rate * dt;
    this.yawRate = rate;
    const v = Math.hypot(this.spinVx, this.spinVy);
    if (v > 0) {
      const nv = Math.max(0, v - this.spinDecelNow * dt);
      this.spinVx *= nv / v;
      this.spinVy *= nv / v;
    }
    this.x += this.spinVx * dt;
    this.y += this.spinVy * dt;
    this.uReq = 0;
    if (this.spinTimer <= 0) {
      this.mode = 'grip';
      this.setVelocity(this.spinVx, this.spinVy);
    }
  }

  // ------------------------------------------------------------------
  // 車同士の接触 (carContact.ts から呼ぶ)

  /** 位置をずらす (めり込みの押し戻し) */
  pushBy(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
  }

  /**
   * 壁にめり込んでいれば位置だけを押し戻す (車同士の押し戻しで壁に押し込まれたとき用)。速度は変えない
   * (壁への速度は次の update の壁の判定で処理される)。押し戻したら true
   */
  pushOutOfWalls(): boolean {
    let moved = false;
    for (let iter = 0; iter < 4; iter++) {
      let maxDepth = 0;
      let nx = 0;
      let ny = 0;
      for (let k = 0; k < outlineLocal.length; k++) {
        this.localToWorld(outlineLocal[k][0], outlineLocal[k][1], tmpPoint);
        this.env.wallContact(tmpPoint.x, tmpPoint.y, this.contact);
        if (this.contact.depth > maxDepth && (this.contact.normalX !== 0 || this.contact.normalY !== 0)) {
          maxDepth = this.contact.depth;
          nx = this.contact.normalX;
          ny = this.contact.normalY;
        }
      }
      if (maxDepth <= 0) break;
      this.x += nx * (maxDepth + 0.05);
      this.y += ny * (maxDepth + 0.05);
      moved = true;
    }
    return moved;
  }

  /** 接触後の速度ベクトルを設定する (sF・sR を計算し直す。スピン中はスピンの速度) */
  applyContactVelocity(vx: number, vy: number): void {
    this.setVelocity(vx, vy);
  }

  /** 接触による長いスピンを始める。direction は回る向き (+1 = 時計回り) */
  startContactSpin(direction: number): void {
    if (this.spinTimer > 0) return;
    this.startSpin('contact', direction);
  }

  /** スピンを始める。light = 壁 (短い)、contact = 車同士の接触 (長い、M2)。direction は回る向き (+1 = 時計回り) */
  private startSpin(kind: 'light' | 'contact', direction: number): void {
    const p = this.params;
    this.spinVx = this.vx;
    this.spinVy = this.vy;
    this.spinDuration = kind === 'light' ? p.spinTimeLight : p.spinTimeContact;
    this.spinTimer = this.spinDuration;
    this.spinRate0 = (kind === 'light' ? p.spinYawLight : p.spinYaw) * direction;
    this.spinDecelNow = kind === 'light' ? p.spinDecelLight : p.spinDecel;
    this.spinStarted = true;
    this.isReversing = false;
    this.mode = 'spin';
    this.closeDrs();
  }

  /** 速度ベクトルから、今のモードの速度を計算し直す */
  private setVelocity(vx: number, vy: number): void {
    if (this.spinTimer > 0) {
      this.spinVx = vx;
      this.spinVy = vy;
      return;
    }
    const s = Math.sin(this.heading);
    const c = Math.cos(this.heading);
    this.sF = vx * s - vy * c;
    this.sR = vx * c + vy * s;
  }

  // ------------------------------------------------------------------
  // 壁 (11.2 節)

  private resolveWalls(dt: number): void {
    const p = this.params;
    let hitNx = 0;
    let hitNy = 0;
    let hitX = 0;
    let hitY = 0;
    let touched = false;
    for (let iter = 0; iter < 4; iter++) {
      let maxDepth = 0;
      let nx = 0;
      let ny = 0;
      for (let k = 0; k < outlineLocal.length; k++) {
        this.localToWorld(outlineLocal[k][0], outlineLocal[k][1], tmpPoint);
        this.env.wallContact(tmpPoint.x, tmpPoint.y, this.contact);
        if (this.contact.depth > -0.5) touched = true;
        if (this.contact.depth > maxDepth && (this.contact.normalX !== 0 || this.contact.normalY !== 0)) {
          maxDepth = this.contact.depth;
          nx = this.contact.normalX;
          ny = this.contact.normalY;
          if (iter === 0 || hitNx === 0) {
            hitX = tmpPoint.x;
            hitY = tmpPoint.y;
          }
        }
      }
      if (maxDepth <= 0) break;
      this.x += nx * (maxDepth + 0.05);
      this.y += ny * (maxDepth + 0.05);
      if (hitNx === 0 && hitNy === 0) {
        hitNx = nx;
        hitNy = ny;
      }
    }
    if (hitNx === 0 && hitNy === 0) {
      this.isScraping = touched && this.speed > 30;
      return;
    }

    // 速度の反応: はね返りと接線方向の減速
    const vx = this.vx;
    const vy = this.vy;
    const vN = vx * hitNx + vy * hitNy;
    this.isScraping = this.speed > 30;
    if (vN >= 0) return;
    const j = -vN;
    const tx = vx - hitNx * vN;
    const ty = vy - hitNy * vN;
    const keep = 1 - Math.min(p.wallTangentLossMax, j / p.wallTangentLossDiv);
    const newVn = -p.wallRestitution * vN;
    const speed = Math.hypot(vx, vy);
    const entryAngle = speed > 0 ? Math.asin(Math.min(1, j / speed)) : 0;
    this.wallImpact = j;
    this.wallImpactX = hitX;
    this.wallImpactY = hitY;
    this.setVelocity(tx * keep + hitNx * newVn, ty * keep + hitNy * newVn);

    if (this.spinTimer <= 0 && j >= p.spinImpulseWall && entryAngle >= p.spinWallMinAngle) {
      // 衝撃が車の右側なら反時計回り
      const side = (hitX - this.x) * Math.cos(this.heading) + (hitY - this.y) * Math.sin(this.heading);
      this.startSpin('light', side > 0 ? -1 : 1);
      return;
    }

    // 向きの補正: 浅い角度でかすったら、車体を壁の接線方向へ寄せる (壁に沿って走り続けられるように)
    if (entryAngle < p.wallAlignMaxAngle && this.sF > 0) {
      // 接線方向のうち、今の進行方向に近いほう
      const fx = Math.sin(this.heading);
      const fy = -Math.cos(this.heading);
      const t1x = -hitNy;
      const t1y = hitNx;
      const tangent = fx * t1x + fy * t1y >= 0 ? Math.atan2(t1x, -t1y) : Math.atan2(-t1x, t1y);
      const diff = wrapAngle(tangent - this.heading);
      const turn = clamp(diff, -p.wallAlignRate * dt, p.wallAlignRate * dt);
      const vxNow = this.vx;
      const vyNow = this.vy;
      this.heading += turn;
      this.setVelocity(vxNow, vyNow);
    }
  }

  // ------------------------------------------------------------------
  // 演出 (16 節)

  private updateEffects(brake: number, dt: number): void {
    const p = this.params;
    const s = this.speed;
    const onTarmac = this.wheelsOffTrack < 2;
    const spinning = this.spinTimer > 0;
    if (spinning) {
      this.squealVolume = 1;
    } else if (onTarmac && s >= p.squealMinSpeed && this.uReq >= p.squealStart) {
      this.squealVolume = clamp((this.uReq - p.squealStart) / p.squealRange, 0, 1);
    } else {
      this.squealVolume = 0;
    }
    this.squealRate = p.squealRateMin + p.squealRateGain * Math.min(s / p.vBase, 1.2);

    // タイヤ痕: 限界超え (後輪)、フルブレーキの開始 (前輪)、スピン (4 輪)
    this.skidRear = spinning || (onTarmac && this.uReq >= p.skidMarkUReq && s >= p.skidMarkMinSpeed);
    if (brake >= 1 && !spinning) {
      if (this.fullBrakeTime === 0 && s >= p.lockupMinSpeed) this.lockupStarted = true;
      this.fullBrakeTime += dt;
    } else {
      this.fullBrakeTime = 0;
    }
    this.skidFront = spinning || (this.fullBrakeTime > 0 && this.fullBrakeTime <= p.lockupMarkTime && s >= p.lockupMinSpeed && onTarmac);

    // 見た目の向き: 限界付近で少し内側に向ける (6.5 節)。スピン中は車体の向きそのもの
    if (spinning) {
      this.drawHeading = this.heading;
    } else {
      const slip = clamp((this.uReq - p.visualSlipStart) * p.visualSlipGain, 0, p.visualSlipMax);
      this.drawHeading = this.heading + Math.sign(this.yawRate) * slip;
    }
  }
}

const tmpPoint = { x: 0, y: 0 };
