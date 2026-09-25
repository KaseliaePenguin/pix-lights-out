/**
 * 回転の方式。fixed = 北が常に上、smooth = 追従対象の向きになめらかに回す、
 * step = 回す角度を rotationSteps 段階に丸める (回転した格子のちらつきを、角度が変わる瞬間だけにする)
 */
export type CameraRotation = 'fixed' | 'smooth' | 'step';

export interface CameraOptions {
  /** 追従先を速度の何秒先にするか */
  lookAheadTime: number;
  /** 先読みの最大距離 (px) */
  lookAheadMax: number;
  /** 追従の速さ: camera += (target - camera) × (1 - e^(-rate × dt)) */
  followRate: number;
  /** 追従対象が画面中央からこれ以上離れないようにする (px) */
  boundX: number;
  boundY: number;
  /** 画面揺れの減衰時間 (秒) */
  shakeTime: number;
  /** 画面揺れの最大振幅 (px) */
  shakeMax: number;
  /** 回転するとき、向きが追従対象の向きに追いつく時定数 (秒) */
  rotationTime: number;
  /** 低速などで「ゆっくり回す」ときの時定数 (秒) */
  rotationSlowTime: number;
  /** step のときの 1 周の段階数 */
  rotationSteps: number;
  /** 回転するときの先読み: 前方 (画面の上) へ base + 速さ × time だけ注視点をずらす (最大 max、px) */
  rotatedLookAheadBase: number;
  rotatedLookAheadTime: number;
  rotatedLookAheadMax: number;
}

/** game-design.md 10.5 節の値 */
const defaultOptions: CameraOptions = {
  lookAheadTime: 0.4,
  lookAheadMax: 190,
  followRate: 4,
  boundX: 250,
  boundY: 170,
  shakeTime: 0.25,
  shakeMax: 6,
  rotationTime: 0.25,
  rotationSlowTime: 1.5,
  rotationSteps: 64,
  rotatedLookAheadBase: 40,
  rotatedLookAheadTime: 0.25,
  rotatedLookAheadMax: 150,
};

/**
 * 北が常に上の追従カメラ。x, y は画面中央のワールド座標 (px)。
 * 描画には renderX / renderY (揺れを足して 2 px 単位に丸めたもの) を使う。
 */
export class Camera {
  x = 0;
  y = 0;
  /** false なら画面揺れを出さない (設定) */
  shakeEnabled = true;
  /** 回転の方式 (設定) */
  rotation: CameraRotation = 'fixed';
  /** 回転するときの向き (0 = 北が上、時計回りが正)。step の丸めを含めない値 */
  angle = 0;
  private lookAhead = 0;

  private shakeAmplitude = 0;
  private shakeTimer = 0;
  private offsetX = 0;
  private offsetY = 0;
  private readonly opt: CameraOptions;

  constructor(options: Partial<CameraOptions> = {}) {
    this.opt = { ...defaultOptions, ...options };
  }

  /** すぐにその位置へ動かす (スタート前・コース復帰後)。heading を渡すと向きもすぐに合わせる */
  snapTo(x: number, y: number, heading?: number): void {
    this.x = x;
    this.y = y;
    if (heading !== undefined) {
      this.angle = heading;
      this.lookAhead = 0;
    }
  }

  /** 画面の描画に使う向き。fixed なら 0、step なら段階に丸めた値 */
  get renderAngle(): number {
    if (this.rotation === 'fixed') return 0;
    if (this.rotation === 'step') {
      const unit = (Math.PI * 2) / this.opt.rotationSteps;
      return Math.round(this.angle / unit) * unit;
    }
    return this.angle;
  }

  /**
   * 回転するカメラの更新。heading は追従対象の進行方向 (0 = 北、時計回り)。
   * hold = 'freeze' なら向きを止め (スピン中・後退中)、'slow' ならゆっくり回す (ごく低速)。
   * 注視点は前方 (画面の上) にずらし、追従対象を画面の下寄りに置く
   */
  updateRotating(dt: number, targetX: number, targetY: number, heading: number, speed: number, hold: 'none' | 'slow' | 'freeze'): void {
    const o = this.opt;
    if (hold !== 'freeze') {
      const tau = hold === 'slow' ? o.rotationSlowTime : o.rotationTime;
      let diff = (heading - this.angle) % (Math.PI * 2);
      if (diff > Math.PI) diff -= Math.PI * 2;
      else if (diff < -Math.PI) diff += Math.PI * 2;
      this.angle += diff * (1 - Math.exp(-dt / tau));
    }
    const wanted = Math.min(o.rotatedLookAheadMax, o.rotatedLookAheadBase + Math.max(0, speed) * o.rotatedLookAheadTime);
    this.lookAhead += (wanted - this.lookAhead) * (1 - Math.exp(-o.followRate * dt));
    // 描画に使う向き (step の丸めを含む) の前方にずらす。向きと注視点がずれると、追従対象が画面の横にぶれるため
    const a = this.renderAngle;
    this.x = targetX + Math.sin(a) * this.lookAhead;
    this.y = targetY - Math.cos(a) * this.lookAhead;
    this.updateShake(dt);
  }

  /** 画面揺れ (画面上のずれ、2 px 単位)。回転するカメラでは、回転後の画面にこれをかける */
  get shakeX(): number {
    return Math.round(this.offsetX / 2) * 2;
  }

  get shakeY(): number {
    return Math.round(this.offsetY / 2) * 2;
  }

  /** 追従対象の位置と速度から、カメラを 1 フレーム分動かす */
  update(dt: number, targetX: number, targetY: number, vx: number, vy: number): void {
    const o = this.opt;
    let ax = vx * o.lookAheadTime;
    let ay = vy * o.lookAheadTime;
    const len = Math.hypot(ax, ay);
    if (len > o.lookAheadMax) {
      ax *= o.lookAheadMax / len;
      ay *= o.lookAheadMax / len;
    }
    const k = 1 - Math.exp(-o.followRate * dt);
    this.x += (targetX + ax - this.x) * k;
    this.y += (targetY + ay - this.y) * k;
    // 追従対象が画面の端に寄りすぎないようにする
    this.x = Math.min(Math.max(this.x, targetX - o.boundX), targetX + o.boundX);
    this.y = Math.min(Math.max(this.y, targetY - o.boundY), targetY + o.boundY);
    this.updateShake(dt);
  }

  private updateShake(dt: number): void {
    const o = this.opt;
    if (this.shakeTimer > 0) {
      this.shakeTimer = Math.max(0, this.shakeTimer - dt);
      const a = this.shakeAmplitude * (this.shakeTimer / o.shakeTime);
      this.offsetX = (Math.random() * 2 - 1) * a;
      this.offsetY = (Math.random() * 2 - 1) * a;
    } else {
      this.offsetX = 0;
      this.offsetY = 0;
    }
  }

  /** 画面揺れ (振幅 px)。強い揺れが来たら差し替える */
  shake(amplitude: number): void {
    if (!this.shakeEnabled) return;
    const a = Math.min(amplitude, this.opt.shakeMax);
    if (a < this.shakeAmplitude * (this.shakeTimer / this.opt.shakeTime)) return;
    this.shakeAmplitude = a;
    this.shakeTimer = this.opt.shakeTime;
  }

  /** 描画に使う位置 (揺れを含め、2 px = 1 ドット単位に丸めたもの) */
  get renderX(): number {
    return Math.round((this.x + this.offsetX) / 2) * 2;
  }

  get renderY(): number {
    return Math.round((this.y + this.offsetY) / 2) * 2;
  }
}
