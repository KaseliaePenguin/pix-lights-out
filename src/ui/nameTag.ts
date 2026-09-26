import { colors } from './colors';
import { teamOf } from './teams';
import { drawText, measureText } from './text';

/** 設定の NAME TAGS (全車 / 自車のみ / なし)。settingsStorage の NameTagMode と同じ値 */
export type NameTagVisibility = 'all' | 'self' | 'off';

export function isNameTagVisible(visibility: NameTagVisibility, isSelf: boolean): boolean {
  return visibility === 'all' || (visibility === 'self' && isSelf);
}

/** 車の中心からタグの中心までの距離 (画面 px、style-guide.md §3) */
const offsetY = 32;

/**
 * 名前タグ `4 VLT` (style-guide.md §3)。screenX / screenY は車の中心の画面座標 (WorldLayer.screenX / screenY)。
 * 地は ink、左端に幅 4px のチーム色の帯、文字は白。自車は白の 2px 枠で囲む。回転しない。
 */
export function drawNameTag(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  carNumber: number,
  abbr: string,
  isSelf: boolean,
): void {
  const text = `${carNumber} ${abbr}`;
  // 帯 4 + 余白 4 + 文字 + 余白 4 (すべて偶数なので 2px の格子に乗る)
  const w = 4 + 4 + measureText(text) + 4;
  const h = 20;
  const x = Math.round((screenX - w / 2) / 2) * 2;
  const y = Math.round((screenY - offsetY - h / 2) / 2) * 2;
  if (isSelf) {
    ctx.fillStyle = colors.white;
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
  }
  ctx.fillStyle = colors.ink;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = teamOf(carNumber).color;
  ctx.fillRect(x, y, 4, h);
  drawText(ctx, text, x + 8, y + 3, { color: colors.white });
}
