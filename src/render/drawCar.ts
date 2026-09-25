import type { WorldLayer } from '../core/WorldLayer';

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
