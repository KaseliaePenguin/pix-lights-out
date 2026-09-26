import type { TouchButton, TouchButtonView, TouchPad } from '../core/TouchPad';
import { colors } from './colors';
import { drawText, measureText } from './text';

interface ButtonStyle {
  label: string;
  /** 幅が足りないときの短い表記 */
  shortLabel: string;
  /** 文字・枠の強調色、押している間の地の色 */
  accent: string;
}

const styles: Record<TouchButton, ButtonStyle> = {
  left: { label: '', shortLabel: '', accent: colors.text },
  right: { label: '', shortLabel: '', accent: colors.text },
  throttle: { label: 'ACCEL', shortLabel: 'GAS', accent: colors.hudGreen },
  brake: { label: 'BRAKE', shortLabel: 'BRK', accent: colors.red },
  drs: { label: 'DRS', shortLabel: 'DRS', accent: colors.hudGreen },
  reset: { label: 'R', shortLabel: 'R', accent: colors.yellow },
  pause: { label: '', shortLabel: '', accent: colors.text },
};

/** 押していないボタンの地の不透明度 (ゲーム画面に重なっても下が見えるように) */
const idleFillAlpha = 0.45;
/** 目立たせない R ボタン (コース復帰が使えないとき) の不透明度 */
const dimAlpha = 0.45;

/**
 * 走行中の画面のボタンを描く (TouchPad の painter)。形はパネル (style-guide.md §6) に合わせ、角を丸めず枠は 1 ドット = 2px。
 * 地だけ半透明にする (ゲーム画面の端に重なることがあるため)。押している間は強調色で塗り、1 ドット沈める
 */
export function drawTouchPad(pad: TouchPad): void {
  const ctx = pad.ctx;
  const d = pad.dot;
  const blink = Math.floor(performance.now() / 250) % 2 === 0;
  for (const b of pad.buttons) {
    const style = styles[b.button];
    let accent = style.accent;
    let alpha = 1;
    let border: string = colors.overlay;
    if (b.button === 'reset') {
      if (pad.options.highlightReset) border = blink ? colors.yellow : colors.white;
      else alpha = dimAlpha;
    } else if (b.button === 'drs') {
      if (pad.options.highlightDrs) border = colors.hudGreen;
      else accent = colors.midGrey;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    drawButtonBody(ctx, b, d, b.isHeld ? accent : null, b.isHeld ? colors.white : border);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2 + (b.isHeld ? d : 0);
    const ink = b.isHeld ? colors.ink : accent;
    switch (b.button) {
      case 'left':
      case 'right':
        drawArrow(ctx, cx, cy, b.button === 'left' ? -1 : 1, Math.max(4, Math.floor(b.w / (d * 2) / 3)), d * 2, ink);
        break;
      case 'pause':
        drawPauseIcon(ctx, cx, cy, d, ink);
        break;
      default: {
        const label = measureText(style.label, d) <= b.w - d * 4 ? style.label : style.shortLabel;
        const scale = b.button === 'reset' ? d * 2 : d;
        drawText(ctx, label, Math.round(cx), Math.round(cy - (7 * scale) / 2), { scale, color: ink, align: 'center' });
        break;
      }
    }
    ctx.restore();
  }
}

/** 枠 (外側 1 ドット ink、内側 1 ドット border) と地 */
function drawButtonBody(ctx: CanvasRenderingContext2D, b: TouchButtonView, d: number, pressedFill: string | null, border: string): void {
  ctx.fillStyle = colors.ink;
  strokeRect(ctx, b.x, b.y, b.w, b.h, d);
  ctx.fillStyle = border;
  strokeRect(ctx, b.x + d, b.y + d, b.w - d * 2, b.h - d * 2, d);
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * (pressedFill ? 0.9 : idleFillAlpha);
  ctx.fillStyle = pressedFill ?? colors.ink;
  ctx.fillRect(b.x + d * 2, b.y + d * 2, b.w - d * 4, b.h - d * 4);
  ctx.globalAlpha = alpha;
}

function strokeRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, t: number): void {
  ctx.fillRect(x, y, w, t);
  ctx.fillRect(x, y + h - t, w, t);
  ctx.fillRect(x, y + t, t, h - t * 2);
  ctx.fillRect(x + w - t, y + t, t, h - t * 2);
}

/** ドットで描く三角形 (dir: -1 = 左向き、1 = 右向き)。size は高さの半分 (ドット) */
function drawArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, dir: number, size: number, px: number, color: string): void {
  ctx.fillStyle = color;
  const top = Math.round(cy - (size + 0.5) * px);
  const left = Math.round(cx - ((size + 1) / 2) * px);
  for (let i = 0; i <= size * 2; i++) {
    const len = size - Math.abs(i - size) + 1;
    const x = dir > 0 ? left : left + (size + 1 - len) * px;
    ctx.fillRect(x, top + i * px, len * px, px);
  }
}

function drawPauseIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, d: number, color: string): void {
  ctx.fillStyle = color;
  const h = d * 7;
  const w = d * 2;
  const top = Math.round(cy - h / 2);
  ctx.fillRect(Math.round(cx - d * 2.5), top, w, h);
  ctx.fillRect(Math.round(cx + d * 0.5), top, w, h);
}

/** 縦向きのときの案内 (ゲームの Canvas に、シーンの上から描く) */
export function drawRotateNotice(ctx: CanvasRenderingContext2D): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.fillStyle = colors.base;
  ctx.fillRect(0, 0, w, h);
  // 縦の電話 → 横の電話 (ドット 4px)
  const px = 4;
  drawPhone(ctx, w / 2 - 150, 150, 14, 24, px, colors.midGrey);
  drawArrow(ctx, w / 2, 198, 1, 6, px, colors.yellow);
  drawPhone(ctx, w / 2 + 50, 174, 24, 14, px, colors.white);
  drawText(ctx, 'ROTATE YOUR PHONE', w / 2, 330, { scale: 6, color: colors.white, align: 'center' });
  drawText(ctx, 'TURN IT SIDEWAYS TO PLAY', w / 2, 404, { scale: 4, color: colors.subtext, align: 'center' });
}

function drawPhone(ctx: CanvasRenderingContext2D, x: number, y: number, wDots: number, hDots: number, px: number, color: string): void {
  ctx.fillStyle = color;
  strokeRect(ctx, x, y, wDots * px, hDots * px, px * 2);
}
