import type { AssetManifest } from './core/Assets';
import type { SoundDef } from './core/AudioManager';

/**
 * 起動時に読み込むアセットと、音ごとの設定 (基準音量など) の表。
 * 音量の初期値は sound-guide.md 4 章のグループの推奨ゲイン。最終的な値は試聴で決め、この表だけを直す。
 */

const images: Record<string, string> = {
  'car-base': '/assets/images/car-base.png',
  'car-base-ghost': '/assets/images/car-base-ghost.png',
  'tile-asphalt': '/assets/images/tile-asphalt.png',
  'tile-grass': '/assets/images/tile-grass.png',
  'tile-gravel': '/assets/images/tile-gravel.png',
  'ui-font-5x7': '/assets/ui/ui-font-5x7.png',
};

const bgmFiles = ['menu-theme', 'qualifying-theme', 'race-theme'];
const seFiles = [
  'engine-player-loop',
  'engine-player-decel-loop',
  'tire-squeal-loop-1',
  'tire-squeal-loop-2',
  'offtrack-grass-loop',
  'offtrack-gravel-loop',
  'kerb-rumble-loop',
  'scrape-loop',
  'crash-wall-1',
  'crash-wall-2',
  'crash-wall-3',
  'drs-open',
  'drs-close',
  'lap-complete',
  'sector-time',
  'sector-best',
  'ui-cursor',
  'ui-confirm',
  'ui-cancel',
  'ui-pause',
  'ui-error',
];
/** sound-list.md で未作成のもの。置かれたら自動で使われる */
const plannedFiles = ['ui-error'];

const sounds: Record<string, string> = {};
for (const name of bgmFiles) sounds[name] = `/assets/sounds/bgm/${name}.ogg`;
for (const name of seFiles) sounds[name] = `/assets/sounds/se/${name}.ogg`;

export const assetManifest: AssetManifest = { images, sounds, optional: plannedFiles };

// sound-guide.md 4 章のグループの推奨ゲイン
const bgmMenu = 0.7;
const bgmRace = 0.4;
const engine = 0.4;
const tyre = 0.45;
const crash = 0.6;
const notify = 0.8;
const ui = 0.6;

/** 音の名前 → 設定。走行画面などはこの名前で鳴らす */
export const soundDefs = {
  // BGM
  'menu-theme': { files: ['menu-theme'], bus: 'bgm', volume: bgmMenu },
  'qualifying-theme': { files: ['qualifying-theme'], bus: 'bgm', volume: bgmRace, fallback: 'race-theme' },
  'race-theme': { files: ['race-theme'], bus: 'bgm', volume: bgmRace },

  // 自車エンジン (AudioManager.createEngine で ON / OFF を組にして使う)
  'engine-player-loop': { files: ['engine-player-loop'], bus: 'drive', volume: engine },
  'engine-player-decel-loop': { files: ['engine-player-decel-loop'], bus: 'drive', volume: engine },

  // タイヤ・路面 (ループ)。release は条件から外れたときのフェードアウト (sound-guide.md 4 章)
  'tire-squeal-loop': {
    files: ['tire-squeal-loop-1', 'tire-squeal-loop-2'],
    bus: 'drive',
    volume: tyre,
    release: 0.15,
    // スキールは特に高音が強いため、走行系共通のフィルターに加えて -3 dB
    highShelfDb: -3,
  },
  'offtrack-grass-loop': { files: ['offtrack-grass-loop'], bus: 'drive', volume: tyre, release: 0.2 },
  'offtrack-gravel-loop': { files: ['offtrack-gravel-loop'], bus: 'drive', volume: tyre, release: 0.2 },
  'kerb-rumble-loop': { files: ['kerb-rumble-loop'], bus: 'drive', volume: tyre, release: 0.2 },

  // 接触
  'crash-wall': {
    files: ['crash-wall-1', 'crash-wall-2', 'crash-wall-3'],
    bus: 'drive',
    volume: crash,
    rateJitter: 0.08,
    maxVoices: 4,
  },
  'scrape-loop': { files: ['scrape-loop'], bus: 'drive', volume: crash, release: 0.15 },

  // 通知
  // drs-open / close は素材が他の短い SE より 8〜11 dB 小さい (sound-list.md の生成記録) ため 2.5 倍にする
  'drs-open': { files: ['drs-open'], bus: 'world', volume: notify * 2.5 },
  'drs-close': { files: ['drs-close'], bus: 'world', volume: notify * 2.5 },
  'lap-complete': { files: ['lap-complete'], bus: 'world', volume: notify },
  'sector-time': { files: ['sector-time'], bus: 'world', volume: notify },
  'sector-best': { files: ['sector-best'], bus: 'world', volume: notify },

  // UI (ポーズ中も鳴る)
  'ui-cursor': { files: ['ui-cursor'], bus: 'ui', volume: ui },
  'ui-confirm': { files: ['ui-confirm'], bus: 'ui', volume: ui },
  'ui-cancel': { files: ['ui-cancel'], bus: 'ui', volume: ui },
  'ui-pause': { files: ['ui-pause'], bus: 'ui', volume: ui },
  // ui-error は未作成。できるまで ui-cancel で代用する
  'ui-error': { files: ['ui-error'], bus: 'ui', volume: ui, fallback: 'ui-cancel' },
} satisfies Record<string, SoundDef>;

export type SoundName = keyof typeof soundDefs;
