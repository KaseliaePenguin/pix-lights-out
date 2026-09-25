/**
 * 設定値の読み書き (仮)。
 * TODO(save): game-engineer のセーブデータ機能ができたら、loadSettings / saveSettings の中身をそちらに差し替える。
 * 呼び出し側 (SettingsScene など) はこの 2 関数と Settings 型だけを使う。
 */

export type NameTagMode = 'all' | 'self' | 'off';

export interface Settings {
  /** 0〜10 */
  bgmVolume: number;
  /** 0〜10 */
  seVolume: number;
  screenShake: boolean;
  showGhost: boolean;
  nameTags: NameTagMode;
}

export const volumeSteps = 10;

export const defaultSettings: Readonly<Settings> = {
  bgmVolume: 8,
  seVolume: 8,
  screenShake: true,
  showGhost: true,
  nameTags: 'all',
};

const storageKey = 'pix-lights-out.settings';

/** 起動中の設定。localStorage に保存できない環境でも、起動している間は変更を保つ */
let cache: Settings | null = null;

/** 呼び出し側が書き換えてもよいよう、毎回コピーを返す */
export function loadSettings(): Settings {
  cache ??= readStoredSettings();
  return { ...cache };
}

export function saveSettings(settings: Settings): void {
  cache = { ...settings };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(cache));
  } catch {
    // 保存できなくてもゲームは続ける (キャッシュにより起動中は有効)
  }
}

function readStoredSettings(): Settings {
  const settings: Settings = { ...defaultSettings };
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return settings;
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return settings;
    const d = data as Record<string, unknown>;
    if (isVolume(d.bgmVolume)) settings.bgmVolume = d.bgmVolume;
    if (isVolume(d.seVolume)) settings.seVolume = d.seVolume;
    if (typeof d.screenShake === 'boolean') settings.screenShake = d.screenShake;
    if (typeof d.showGhost === 'boolean') settings.showGhost = d.showGhost;
    if (d.nameTags === 'all' || d.nameTags === 'self' || d.nameTags === 'off') settings.nameTags = d.nameTags;
  } catch {
    // 使えない環境 (プライベートモードなど) や壊れたデータは既定値で続ける
  }
  return settings;
}

/**
 * タイムアタックの自己ベスト (メニューに表示)。
 * TODO(save): ゴースト・自己ベストの保存は game-engineer の担当。できたらそちらから読む。
 */
export function loadTimeAttackBest(): number | null {
  return null;
}

function isVolume(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= volumeSteps;
}
