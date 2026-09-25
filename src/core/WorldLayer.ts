/**
 * ワールド層: 400×300 のオフスクリーン Canvas に 1 ドット = 1 px で描き、2 倍に拡大して画面に転送する
 * (style-guide.md §1、car-physics.md 2.2 節)。
 * ワールド座標 (px) は 2 px = 1 ドット。setCamera でカメラ位置を決めてから dotX / dotY で変換して描く。
 *
 * カメラを回転させる場合は、回転しても画面の四隅が欠けない大きさ (画面の対角線ぶん、例: 504×504) で作り、
 * 北が上のまま描いてから、present で回転して転送する。オフスクリーンへの描き方は回転の有無で変わらない。
 */
export class WorldLayer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** 画面の左上のワールド座標をドット単位にしたもの */
  private originX = 0;
  private originY = 0;
  /** カメラ (画面の基準点) のワールド座標と向き (0 = 北が上、時計回りが正) */
  private cameraX = 0;
  private cameraY = 0;
  private angle = 0;
  /** 画面 (転送先) の大きさ。基準点は画面の中央 */
  private readonly screenWidth: number;
  private readonly screenHeight: number;

  constructor(
    readonly width = 400,
    readonly height = 300,
    /** 1 ドットのワールド座標・画面上の大きさ (px) */
    readonly scale = 2,
    screenWidth = 800,
    screenHeight = 600,
  ) {
    this.screenWidth = screenWidth;
    this.screenHeight = screenHeight;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is not supported');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
  }

  /**
   * カメラ (画面中央のワールド座標、px) を設定する。ドット単位に丸めるので、カメラが動いても 1 ドット未満のずれは出ない
   */
  setCamera(cameraX: number, cameraY: number, angle = 0): void {
    this.cameraX = cameraX;
    this.cameraY = cameraY;
    this.angle = angle;
    this.originX = Math.round(cameraX / this.scale) - this.width / 2;
    this.originY = Math.round(cameraY / this.scale) - this.height / 2;
  }

  /** カメラが回転しているか (向きが 0 でない) */
  get isRotated(): boolean {
    return this.angle !== 0;
  }

  /** カメラの向き (setCamera で渡した値) */
  get cameraAngle(): number {
    return this.angle;
  }

  /**
   * ワールド座標 (px) → 画面の座標 (px、丸めない)。回転を含む。
   * 回転の有無によらず、画面の中央がカメラの位置 (回転なしのときは screenX / screenY と同じ位置になる)
   */
  worldToScreen(worldX: number, worldY: number, out: { x: number; y: number }): { x: number; y: number } {
    const dx = worldX - this.cameraX;
    const dy = worldY - this.cameraY;
    const c = Math.cos(-this.angle);
    const s = Math.sin(-this.angle);
    out.x = this.screenWidth / 2 + dx * c - dy * s;
    out.y = this.screenHeight / 2 + dx * s + dy * c;
    return out;
  }

  /** ワールドでの向き (0 = 北、時計回り) → 画面上の向き (0 = 上、時計回り) */
  toScreenAngle(worldAngle: number): number {
    return worldAngle - this.angle;
  }

  /** 画面の左上のワールド座標 (px)。背景のタイルを並べるときなどに使う */
  get viewLeft(): number {
    return this.originX * this.scale;
  }

  get viewTop(): number {
    return this.originY * this.scale;
  }

  /** ワールド座標 (px) → オフスクリーンのドット座標 (整数) */
  dotX(worldX: number): number {
    return Math.round(worldX / this.scale) - this.originX;
  }

  dotY(worldY: number): number {
    return Math.round(worldY / this.scale) - this.originY;
  }

  /** ワールド座標 (px) → 画面 (800×600) の座標 (2 px 単位)。名前タグなど HUD 側で描くものに使う */
  screenX(worldX: number): number {
    return this.dotX(worldX) * this.scale;
  }

  screenY(worldY: number): number {
    return this.dotY(worldY) * this.scale;
  }

  /** ワールド座標の点が画面内 (margin px の余裕を含む) にあるか */
  isVisible(worldX: number, worldY: number, margin = 64): boolean {
    const x = worldX - this.viewLeft;
    const y = worldY - this.viewTop;
    return x >= -margin && y >= -margin && x <= this.width * this.scale + margin && y <= this.height * this.scale + margin;
  }

  /** オフスクリーン全体を塗りつぶす (毎フレームの最初に呼ぶ) */
  clear(color: string): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  /**
   * 画像を、中心をワールド座標 (px) に合わせて回転して描く。angle は 0 = 北、時計回りが正 (スプライトは北向き)。
   * 中心はドット単位に丸める
   */
  drawRotated(image: CanvasImageSource, worldX: number, worldY: number, angle: number, imageWidth: number, imageHeight: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.dotX(worldX), this.dotY(worldY));
    ctx.rotate(angle);
    ctx.drawImage(image, -imageWidth / 2, -imageHeight / 2, imageWidth, imageHeight);
    ctx.restore();
  }

  /**
   * ワールド層を画面 (target) に拡大して転送する。(x, y) は画面上でずらす量 (px、画面揺れなど)。
   * カメラが回転していれば、カメラの位置を画面の中央に合わせて回転する。
   * 回転時はオフスクリーンの位置をドット単位に丸めた分のずれを戻し、回転した画面の上で位置がなめらかに動くようにする
   */
  present(target: CanvasRenderingContext2D, x = 0, y = 0, isSmooth = false): void {
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.imageSmoothingEnabled = isSmooth;
    const isScreenSized = this.width * this.scale === this.screenWidth && this.height * this.scale === this.screenHeight;
    if (this.angle === 0 && isScreenSized) {
      // 北が上で固定の表示: そのまま 2 倍にする (カメラはドット単位に丸めたまま)
      target.drawImage(this.canvas, x, y, this.screenWidth, this.screenHeight);
    } else {
      // オフスクリーンの中央 (ドット単位に丸めたカメラ) と、本当のカメラ位置の差 (px)
      const fracX = this.cameraX - (this.originX + this.width / 2) * this.scale;
      const fracY = this.cameraY - (this.originY + this.height / 2) * this.scale;
      target.translate(this.screenWidth / 2 + x, this.screenHeight / 2 + y);
      target.rotate(-this.angle);
      target.drawImage(
        this.canvas,
        -(this.width * this.scale) / 2 - fracX,
        -(this.height * this.scale) / 2 - fracY,
        this.width * this.scale,
        this.height * this.scale,
      );
    }
    target.restore();
  }
}
