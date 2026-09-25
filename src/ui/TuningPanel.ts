import type { Input } from '../core/Input';
import type { TuningItem, TuningStore } from '../core/TuningStore';
import { colors } from './colors';
import { drawPanel } from './panel';
import { drawText } from './text';

/**
 * 調整パネルのキー。走行のキー (←→・Z・X・Space・R・Esc) と重ならないものにして、開いたまま走れるようにする
 */
const keys = {
  itemUp: ['KeyI', 'PageUp'],
  itemDown: ['KeyK', 'PageDown'],
  groupPrev: ['KeyU', 'Home'],
  groupNext: ['KeyO', 'End'],
  decrease: ['KeyJ'],
  increase: ['KeyL'],
  reset: ['Backspace'],
  copy: ['KeyC'],
} as const;
const fineKeys = ['ShiftLeft', 'ShiftRight'];
/** 値のキーを押し続けたときの繰り返し (秒) */
const repeatDelay = 0.35;
const repeatInterval = 0.05;
const visibleRows = 10;
const panelX = 12;
// 上中央のメッセージ帯 (y88-114) と左下のミニマップの間に置く
const panelY = 124;
const panelW = 360;
const rowH = 20;
const noticeTime = 2;

/**
 * 開発時の調整パネル (F4 で開閉)。選んだ項目の値を J / L で変える (Shift で 10 分の 1)。
 * 描画は画面の左上。開いていなくても update を呼んでよい (F4 だけを見る)
 */
export class TuningPanel {
  isOpen = false;
  private groupIndex = 0;
  private itemIndex = 0;
  private scroll = 0;
  private repeatKey: string | null = null;
  private repeatTimer = 0;
  private notice = '';
  private noticeTimer = 0;

  constructor(
    private readonly store: TuningStore,
    private readonly input: Input,
    /** 値が変わったときに呼ぶ (記録を保存しない印を付けるなど) */
    private readonly onChange: () => void = () => undefined,
  ) {
    for (const code of ['F4', 'PageUp', 'PageDown', 'Home', 'End']) input.blockKey(code);
  }

  update(dt: number): void {
    const input = this.input;
    if (input.wasPressed('F4')) this.isOpen = !this.isOpen;
    this.noticeTimer = Math.max(0, this.noticeTimer - dt);
    if (!this.isOpen) return;

    const items = this.groupItems();
    if (this.anyPressed(keys.groupPrev)) this.moveGroup(-1);
    else if (this.anyPressed(keys.groupNext)) this.moveGroup(1);
    else if (this.anyPressed(keys.itemUp)) this.moveItem(-1, items.length);
    else if (this.anyPressed(keys.itemDown)) this.moveItem(1, items.length);

    const item = this.groupItems()[this.itemIndex];
    const isFine = fineKeys.some((c) => input.isDown(c));
    if (item) {
      const direction = this.valueDirection(dt);
      if (direction !== 0) {
        this.store.adjust(item, direction * (isFine ? 0.1 : 1));
        this.onChange();
      }
      if (this.anyPressed(keys.reset)) {
        if (isFine) this.store.resetAll();
        else this.store.resetItem(item);
        this.onChange();
      }
    }
    if (this.anyPressed(keys.copy)) this.copyJson();
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.isOpen) return;
    const store = this.store;
    const items = this.groupItems();
    const group = store.groups[this.groupIndex] ?? '';
    const rows = Math.min(visibleRows, items.length);
    const h = 56 + rows * rowH + 44;
    drawPanel(ctx, panelX, panelY, panelW, h);
    drawText(ctx, 'TUNING', panelX + 8, panelY + 8, { color: colors.yellow });
    drawText(ctx, `${this.groupIndex + 1}/${store.groups.length}`, panelX + panelW - 8, panelY + 8, {
      color: colors.midGrey,
      align: 'right',
    });
    drawText(ctx, `< ${toLabel(group)} >`, panelX + panelW / 2, panelY + 30, { color: colors.white, align: 'center' });

    for (let r = 0; r < rows; r++) {
      const index = this.scroll + r;
      const item = items[index];
      if (!item) break;
      const y = panelY + 56 + r * rowH;
      const isSelected = index === this.itemIndex;
      if (isSelected) {
        ctx.fillStyle = colors.surface;
        ctx.fillRect(panelX + 4, y - 4, panelW - 8, rowH);
      }
      const color = store.isItemModified(item) ? colors.yellow : isSelected ? colors.white : colors.subtext;
      drawText(ctx, toLabel(item.label), panelX + 10, y, { color });
      drawText(ctx, formatValue(item.value), panelX + panelW - 10, y, { color, align: 'right' });
    }
    const footY = panelY + 56 + rows * rowH + 4;
    if (items.length > rows) {
      // 項目がはみ出すグループでは、見えている範囲を出す
      drawText(ctx, `${this.scroll + 1}-${this.scroll + rows}/${items.length}`, panelX + panelW - 10, footY, {
        color: colors.midGrey,
        align: 'right',
      });
    }
    const selected = items[this.itemIndex];
    const hint = this.noticeTimer > 0 ? this.notice : selected ? `DEFAULT ${formatValue(selected.defaultValue)}  STEP ${formatValue(selected.step)}` : '';
    drawText(ctx, hint, panelX + 10, footY, { color: this.noticeTimer > 0 ? colors.hudGreen : colors.midGrey });
    drawText(ctx, 'I/K ITEM U/O GROUP J/L VALUE', panelX + 10, footY + 18, { color: colors.midGrey });
  }

  private groupItems(): TuningItem[] {
    const group = this.store.groups[this.groupIndex];
    return this.store.items.filter((item) => item.group === group);
  }

  private moveGroup(step: number): void {
    const n = this.store.groups.length;
    if (n === 0) return;
    this.groupIndex = (this.groupIndex + step + n) % n;
    this.itemIndex = 0;
    this.scroll = 0;
  }

  private moveItem(step: number, count: number): void {
    if (count === 0) return;
    this.itemIndex = (this.itemIndex + step + count) % count;
    if (this.itemIndex < this.scroll) this.scroll = this.itemIndex;
    if (this.itemIndex >= this.scroll + visibleRows) this.scroll = this.itemIndex - visibleRows + 1;
  }

  /** 値のキー: 押した瞬間に 1 回、押し続けると repeatDelay 秒後から繰り返す */
  private valueDirection(dt: number): number {
    const input = this.input;
    for (const [code, direction] of [
      [keys.decrease[0], -1],
      [keys.increase[0], 1],
    ] as const) {
      if (input.wasPressed(code)) {
        this.repeatKey = code;
        this.repeatTimer = repeatDelay;
        return direction;
      }
      if (this.repeatKey === code && input.isDown(code)) {
        this.repeatTimer -= dt;
        if (this.repeatTimer <= 0) {
          this.repeatTimer += repeatInterval;
          return direction;
        }
        return 0;
      }
    }
    this.repeatKey = null;
    return 0;
  }

  private copyJson(): void {
    const json = this.store.toJson();
    const fallback = (): void => {
      console.log(`調整した値 (carParams.ts などに反映する):\n${json}`);
      this.showNotice('SEE CONSOLE');
    };
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard) {
      fallback();
      return;
    }
    clipboard.writeText(json).then(() => {
      console.log(`調整した値をクリップボードにコピーしました:\n${json}`);
      this.showNotice('COPIED JSON');
    }, fallback);
  }

  private showNotice(text: string): void {
    this.notice = text;
    this.noticeTimer = noticeTime;
  }

  private anyPressed(codes: readonly string[]): boolean {
    for (const c of codes) if (this.input.wasPressed(c)) return true;
    return false;
  }
}

/** latGrip → LAT GRIP (HUD のフォントは英大文字のみ) */
function toLabel(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toUpperCase();
}

function formatValue(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(0);
  return String(Number(value.toPrecision(4)));
}
