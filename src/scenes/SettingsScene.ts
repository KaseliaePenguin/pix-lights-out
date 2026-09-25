import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { colors } from '../ui/colors';
import { drawFooterHint, drawMenuList, drawScreenTitle } from '../ui/menuList';
import type { MenuItemView } from '../ui/menuList';
import { HelpScene } from './HelpScene';
import {
  moveMenuCursor,
  wasMenuBackPressed,
  wasMenuConfirmPressed,
  wasMenuDownPressed,
  wasMenuLeftPressed,
  wasMenuRightPressed,
  wasMenuUpPressed,
} from './menuKeys';
import { loadSettings, saveSettings, volumeSteps } from './settingsStorage';
import type { NameTagMode, Settings } from './settingsStorage';

type SettingsItem = 'bgmVolume' | 'seVolume' | 'screenShake' | 'showGhost' | 'nameTags' | 'controls' | 'back';

const items: readonly SettingsItem[] = ['bgmVolume', 'seVolume', 'screenShake', 'showGhost', 'nameTags', 'controls', 'back'];
const nameTagModes: readonly NameTagMode[] = ['all', 'self', 'off'];
const nameTagLabels: Record<NameTagMode, string> = { all: 'ALL', self: 'SELF', off: 'OFF' };

/**
 * 設定画面 (game-design.md 4 章の M1 項目)。値は変えた時点で保存する。
 * 戻り先は onBack で決める。メニューからは単独のシーンとして、ポーズ画面からは子として使う。
 */
export class SettingsScene implements Scene {
  private readonly settings: Settings = loadSettings();
  private selected = 0;
  /** 操作確認を開いている間の子画面 */
  private child: Scene | null = null;

  constructor(
    private readonly game: Game,
    private readonly onBack: () => void,
  ) {}

  update(dt: number): void {
    if (this.child) {
      this.child.update(dt);
      return;
    }
    const { input } = this.game;
    const enabled = items.map(() => true);
    if (wasMenuUpPressed(input)) {
      this.selected = moveMenuCursor(this.selected, -1, enabled);
      // TODO(audio): ui-cursor
    } else if (wasMenuDownPressed(input)) {
      this.selected = moveMenuCursor(this.selected, 1, enabled);
      // TODO(audio): ui-cursor
    } else if (wasMenuLeftPressed(input)) {
      this.changeValue(-1);
    } else if (wasMenuRightPressed(input)) {
      this.changeValue(1);
    } else if (wasMenuConfirmPressed(input)) {
      this.confirm();
    } else if (wasMenuBackPressed(input)) {
      // TODO(audio): ui-cancel
      this.onBack();
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (this.child) {
      this.child.render(ctx);
      return;
    }
    const { width, height } = this.game;
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, width, height);
    drawScreenTitle(ctx, 'SETTINGS', width / 2, 48);
    drawMenuList(ctx, items.map((item) => this.toView(item)), this.selected, { x: 180, y: 128, width: 440 });
    drawFooterHint(ctx, 'UP/DOWN: SELECT  LEFT/RIGHT: CHANGE  ESC: BACK', width / 2, height - 36);
  }

  private changeValue(step: number): void {
    const s = this.settings;
    switch (items[this.selected]) {
      case 'bgmVolume':
        s.bgmVolume = clamp(s.bgmVolume + step, 0, volumeSteps);
        // TODO(audio): BGM の音量を s.bgmVolume / volumeSteps に反映する
        break;
      case 'seVolume':
        s.seVolume = clamp(s.seVolume + step, 0, volumeSteps);
        // TODO(audio): 効果音の音量を反映し、確認用に ui-cursor を新しい音量で鳴らす
        break;
      case 'screenShake':
        s.screenShake = !s.screenShake;
        break;
      case 'showGhost':
        s.showGhost = !s.showGhost;
        break;
      case 'nameTags': {
        const index = nameTagModes.indexOf(s.nameTags);
        s.nameTags = nameTagModes[(index + step + nameTagModes.length) % nameTagModes.length];
        break;
      }
      default:
        return;
    }
    // TODO(audio): ui-cursor
    saveSettings(s);
  }

  private confirm(): void {
    switch (items[this.selected]) {
      case 'screenShake':
      case 'showGhost':
      case 'nameTags':
        this.changeValue(1);
        break;
      case 'controls':
        // TODO(audio): ui-confirm
        this.child = new HelpScene(this.game, () => {
          this.child = null;
        });
        break;
      case 'back':
        // TODO(audio): ui-cancel
        this.onBack();
        break;
      default:
        break;
    }
  }

  private toView(item: SettingsItem): MenuItemView {
    const s = this.settings;
    switch (item) {
      case 'bgmVolume':
        return { label: 'BGM VOLUME', isEnabled: true, bar: { level: s.bgmVolume, max: volumeSteps } };
      case 'seVolume':
        return { label: 'SE VOLUME', isEnabled: true, bar: { level: s.seVolume, max: volumeSteps } };
      case 'screenShake':
        return { label: 'SCREEN SHAKE', isEnabled: true, value: onOff(s.screenShake) };
      case 'showGhost':
        return { label: 'GHOST', isEnabled: true, value: onOff(s.showGhost) };
      case 'nameTags':
        return { label: 'NAME TAGS', isEnabled: true, value: nameTagLabels[s.nameTags] };
      case 'controls':
        return { label: 'CONTROLS', isEnabled: true };
      case 'back':
        return { label: 'BACK', isEnabled: true };
    }
  }
}

function onOff(value: boolean): string {
  return value ? 'ON' : 'OFF';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
