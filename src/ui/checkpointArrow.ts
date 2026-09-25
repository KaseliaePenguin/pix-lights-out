import { colors } from './colors';

// 7×7 ドットの矢印。回転はドットの格子ごと 90° 単位で行う (回転描画でドットを崩さないため)
const arrowRight = [
  '...X...',
  '...XX..',
  'XXXXXX.',
  'XXXXXXX',
  'XXXXXX.',
  '...XX..',
  '...X...',
];
const arrowUpRight = [
  '..XXXXX',
  '...XXXX',
  '....XXX',
  '...XXXX',
  '..XXX.X',
  '.XXX...',
  'XXX....',
];
const size = 7;
/** 1 ドットの大きさ (px)。画面の 2 ドットぶんで大きめに見せる */
const dot = 4;

// 走行エリア (style-guide.md §6: x200-580 y120-540) の内側に置く
const centerX = 390;
const centerY = 330;
const reachX = 170;
const reachY = 190;

/**
 * 未通過のチェックポイントの方向を示す矢印 (game-design.md 7.4 節)。
 * angle は画面上の向き (ラジアン、0 = 右、π/2 = 下)。8 方向に丸めて、走行エリアの端に描く。
 */
export function drawCheckpointArrow(ctx: CanvasRenderingContext2D, angle: number, color: string = colors.yellow): void {
  const octant = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
  const pattern = octant % 2 === 0 ? arrowRight : arrowUpRight;
  // 右向きは 0 (東) から、右上向きは 7 (北東) から時計回りに 90° ずつ回す
  const turns = octant % 2 === 0 ? octant / 2 : ((octant + 1) % 8) / 2;

  const dirX = Math.cos(octant * (Math.PI / 4));
  const dirY = Math.sin(octant * (Math.PI / 4));
  const t = Math.min(
    Math.abs(dirX) > 1e-6 ? reachX / Math.abs(dirX) : Infinity,
    Math.abs(dirY) > 1e-6 ? reachY / Math.abs(dirY) : Infinity,
  );
  const half = (size * dot) / 2;
  const left = Math.round((centerX + dirX * t - half) / 2) * 2;
  const top = Math.round((centerY + dirY * t - half) / 2) * 2;

  const cells: Array<[number, number]> = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (pattern[y][x] !== 'X') continue;
      let cx = x;
      let cy = y;
      for (let i = 0; i < turns; i++) {
        const nx = size - 1 - cy;
        cy = cx;
        cx = nx;
      }
      cells.push([cx, cy]);
    }
  }

  // 輪郭 (外側 2px = 画面の 1 ドットの ink) を先に描いてから本体を描く
  ctx.fillStyle = colors.ink;
  for (const [cx, cy] of cells) ctx.fillRect(left + cx * dot - 2, top + cy * dot - 2, dot + 4, dot + 4);
  ctx.fillStyle = color;
  for (const [cx, cy] of cells) ctx.fillRect(left + cx * dot, top + cy * dot, dot, dot);
}
