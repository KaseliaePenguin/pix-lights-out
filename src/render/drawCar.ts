import type { WorldLayer } from '../core/WorldLayer';
import type { Car } from '../shared/Car';

const drsWindColor = '#ffffff';

/** 車のスプライトの大きさ (ドット)。中身は 10×20、回転の中心はファイルの中心 */
const spriteSize = 24;

/** style-guide.md §2 の設計図 (北向き)。K = 輪郭、P = 車体、T = タイヤ、H = ヘルメット */
const blueprint = [
  '.KPPPPPPK.',
  '.KKKPPKKK.',
  'TT..PP..TT',
  'TT..PP..TT',
  'TT.KPPK.TT',
  '...KPPK...',
  '..KPPPPK..',
  '.KPPKKPPK.',
  '.KPKHHKPK.',
  '.KPKKKKPK.',
  '.KPPPPPPK.',
  '.KPPPPPPK.',
  '.KPPPPPPK.',
  '..KPPPPK..',
  'TTKPPPPKTT',
  'TT.KPPK.TT',
  'TT.KPPK.TT',
  'TT..KK..TT',
  'KPPPPPPPPK',
  'KKKKKKKKKK',
];

const fallbackColors: Readonly<Record<string, string>> = { K: '#11111b', T: '#11111b', P: '#e8322b', H: '#cdd6f4' };

let fallbackSprite: HTMLCanvasElement | null = null;

/**
 * 車を描く。image は 24×24 ドット・北向きのスプライト。読めていなければ設計図から作った赤い車で代用する。
 * heading は 0 = 北、時計回りが正 (滑り角を含めた Car.drawHeading を渡す)
 */
export function drawCar(layer: WorldLayer, image: HTMLImageElement | null, x: number, y: number, heading: number): void {
  const sprite: CanvasImageSource = image && image.width > 0 ? image : getFallbackSprite();
  layer.drawRotated(sprite, x, y, heading, spriteSize, spriteSize);
}

/**
 * 車を画面 (800×600) に直接描く (カメラが回転するとき用)。(screenX, screenY) は画面上の中心、
 * angle は画面上の向き (0 = 上、時計回り)。1 ドット = 2 px のまま回転するので、ワールド層に描いてから
 * 回転して転送するより、スプライトの崩れが少ない (回転は 1 回だけ)
 */
export function drawCarOnScreen(ctx: CanvasRenderingContext2D, image: HTMLImageElement | null, screenX: number, screenY: number, angle: number): void {
  const sprite: CanvasImageSource = image && image.width > 0 ? image : getFallbackSprite();
  const size = spriteSize * 2;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(screenX, screenY);
  ctx.rotate(angle);
  ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
  ctx.restore();
}

/**
 * DRS が開いている間、車の後方に風の線 (白、2 本、ちらつかせる)。time はちらつきの位相に使う経過秒、
 * point は計算用の作業領域
 */
export function drawDrsWind(layer: WorldLayer, car: Car, time: number, point: { x: number; y: number }): void {
  const ctx = layer.ctx;
  ctx.fillStyle = drsWindColor;
  const phase = Math.floor(time * 20) % 3;
  for (const side of [-4, 4]) {
    for (let k = 0; k < 3; k++) {
      if (k === phase) continue;
      car.localToWorld(side, -26 - k * 6, point);
      ctx.fillRect(layer.dotX(point.x), layer.dotY(point.y), 1, 2);
    }
  }
}

function getFallbackSprite(): HTMLCanvasElement {
  if (fallbackSprite) return fallbackSprite;
  const canvas = document.createElement('canvas');
  canvas.width = spriteSize;
  canvas.height = spriteSize;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const ox = (spriteSize - 10) / 2;
    const oy = (spriteSize - 20) / 2;
    blueprint.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = fallbackColors[row[x]];
        if (!c) continue;
        ctx.fillStyle = c;
        ctx.fillRect(ox + x, oy + y, 1, 1);
      }
    });
  }
  fallbackSprite = canvas;
  return canvas;
}
