/**
 * ワールド層: 400×300 のオフスクリーン Canvas に 1 ドット = 1 px で描き、2 倍に拡大して画面に転送する
 * (style-guide.md §1、car-physics.md 2.2 節)。
 * ワールド座標 (px) は 2 px = 1 ドット。setCamera でカメラ位置を決めてから dotX / dotY で変換して描く。
 */
export class WorldLayer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** 画面の左上のワールド座標をドット単位にしたもの */
  private originX = 0;
  private originY = 0;

  constructor(
    readonly width = 400,
    readonly height = 300,
    /** 1 ドットのワールド座標・画面上の大きさ (px) */
    readonly scale = 2,
  ) {
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
  setCamera(cameraX: number, cameraY: number): void {
    this.originX = Math.round(cameraX / this.scale) - this.width / 2;
    this.originY = Math.round(cameraY / this.scale) - this.height / 2;
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

  /** ワールド層を画面 (target) に拡大して転送する */
  present(target: CanvasRenderingContext2D, x = 0, y = 0): void {
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.imageSmoothingEnabled = false;
    target.drawImage(this.canvas, x, y, this.width * this.scale, this.height * this.scale);
    target.restore();
  }
}
