import type { AudioManager } from '../core/AudioManager';
import { SaveData } from '../core/SaveData';
import { recordVersionOf } from '../shared/carParams';
import { course1 } from '../shared/tracks/course1';

/**
 * 設定値と自己ベストの読み書き (セーブデータ SaveData の、ゲーム側の窓口)。
 * 呼び出し側 (SettingsScene など) は loadSettings / saveSettings と Settings 型を使う。
 * 走行画面は saveData から自己ベスト・ゴーストを直接読み書きする。
 */

/** ゲーム全体で 1 つのセーブデータ */
export const saveData = new SaveData('pix-lights-out');

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

/** 起動中の設定 (検証済み)。保存できない環境でも SaveData がメモリ上の値を保つ */
let cache: Settings | null = null;

/** 呼び出し側が書き換えてもよいよう、毎回コピーを返す */
export function loadSettings(): Settings {
  cache ??= toSettings(saveData.loadSettings());
  return { ...cache };
}

export function saveSettings(settings: Settings): void {
  cache = { ...settings };
  saveData.saveSettings(cache);
}

/** 設定の BGM・効果音の音量を音の出力に反映する */
export function applyVolumeSettings(audio: AudioManager, settings: Settings): void {
  audio.setBgmVolume(settings.bgmVolume / volumeSteps);
  audio.setSeVolume(settings.seVolume / volumeSteps);
}

/** 保存されていた値のうち正しいものだけを使い、残りは既定値にする */
function toSettings(d: Record<string, unknown> | null): Settings {
  const settings: Settings = { ...defaultSettings };
  if (d === null) return settings;
  if (isVolume(d.bgmVolume)) settings.bgmVolume = d.bgmVolume;
  if (isVolume(d.seVolume)) settings.seVolume = d.seVolume;
  if (typeof d.screenShake === 'boolean') settings.screenShake = d.screenShake;
  if (typeof d.showGhost === 'boolean') settings.showGhost = d.showGhost;
  if (d.nameTags === 'all' || d.nameTags === 'self' || d.nameTags === 'off') settings.nameTags = d.nameTags;
  return settings;
}

/**
 * タイムアタックの自己ベスト (メニューに表示)。M1 はコース 1 だけ。
 * 保存キーのバージョンは走行画面と同じ recordVersionOf で作る (違うと、読んだ側が記録を破棄してしまう)。
 * Track の生成は重いので、コースデータ (version を持つ) をそのまま渡す
 */
export function loadTimeAttackBest(): number | null {
  return saveData.loadBest(course1.id, recordVersionOf(course1))?.bestLap ?? null;
}

function isVolume(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= volumeSteps;
}
