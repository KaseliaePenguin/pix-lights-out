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

  private shakeAmplitude = 0;
  private shakeTimer = 0;
  private offsetX = 0;
  private offsetY = 0;
  private readonly opt: CameraOptions;

  constructor(options: Partial<CameraOptions> = {}) {
    this.opt = { ...defaultOptions, ...options };
  }

  /** すぐにその位置へ動かす (スタート前・コース復帰後) */
  snapTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
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
