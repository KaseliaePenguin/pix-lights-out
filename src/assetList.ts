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
  'tile-pit': '/assets/images/tile-pit.png',
  'ui-font-5x7': '/assets/ui/ui-font-5x7.png',
  'ui-lamp-on': '/assets/ui/ui-lamp-on.png',
  'ui-lamp-off': '/assets/ui/ui-lamp-off.png',
  'title-bg': '/assets/images/title-bg.png',
  'title-logo': '/assets/images/title-logo.png',
};
// チームの車 (車番 1〜8): car-team-01 〜 car-team-08 と、そのシャドウ表示 (ゴースト中) car-team-01-ghost 〜
for (let team = 1; team <= 8; team++) {
  const name = `car-team-${String(team).padStart(2, '0')}`;
  images[name] = `/assets/images/${name}.png`;
  images[`${name}-ghost`] = `/assets/images/${name}-ghost.png`;
}

/** JSON のデータ */
const data: Record<string, string> = {
  'title-paths': '/assets/data/title-paths.json',
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
  'tire-barrier-hit-1',
  'tire-barrier-hit-2',
  'tire-lockup-1',
  'tire-lockup-2',
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
/** sound-list.md で未作成のもの (読めなくても警告しない)。置かれたら自動で使われる */
const plannedBgmFiles = ['result-theme', 'finish-jingle', 'win-jingle'];
const plannedSeFiles = [
  'start-light-on',
  'start-go',
  'false-start',
  'crash-car-1',
  'crash-car-2',
  'crash-car-3',
  'drs-available',
  'final-lap',
  'position-change',
  'slipstream-wind-loop',
  'gear-shift-1',
  'gear-shift-2',
  'engine-rev-1',
  'engine-rev-2',
];
const plannedFiles: string[] = [...plannedBgmFiles, ...plannedSeFiles];

const sounds: Record<string, string> = {};
for (const name of [...bgmFiles, ...plannedBgmFiles]) sounds[name] = `/assets/sounds/bgm/${name}.ogg`;
for (const name of [...seFiles, ...plannedSeFiles]) sounds[name] = `/assets/sounds/se/${name}.ogg`;

export const assetManifest: AssetManifest = { images, sounds, data, optional: plannedFiles };

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
  // リザルトの曲ができるまではメニューの曲を流す
  'result-theme': { files: ['result-theme'], bus: 'bgm', volume: bgmMenu, fallback: 'menu-theme' },
  // 自分のゴールで 1 回 (BGM と同じ音量設定)。優勝したときは win-jingle、なければ finish-jingle
  'finish-jingle': { files: ['finish-jingle'], bus: 'bgm', volume: bgmMenu },
  'win-jingle': { files: ['win-jingle'], bus: 'bgm', volume: bgmMenu, fallback: 'finish-jingle' },

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
  // フルブレーキの開始時に 1 回 (ワンショット)
  'tire-lockup': {
    files: ['tire-lockup-1', 'tire-lockup-2'],
    bus: 'drive',
    volume: tyre,
    // -2 は平均音量が -1 より約 7 dB 小さい (ピークは同じ) ため 2 倍にする
    fileVolumes: [1, 2],
    rateJitter: 0.05,
    highShelfDb: -3,
  },

  // 接触
  'crash-wall': {
    files: ['crash-wall-1', 'crash-wall-2', 'crash-wall-3'],
    bus: 'drive',
    volume: crash,
    rateJitter: 0.08,
    maxVoices: 4,
  },
  // 弱い衝突 (強さ 187.5 未満)。強さで音量を変えるのは crash-wall と同じ
  'tire-barrier-hit': {
    files: ['tire-barrier-hit-1', 'tire-barrier-hit-2'],
    bus: 'drive',
    volume: crash,
    rateJitter: 0.08,
    maxVoices: 4,
  },
  'scrape-loop': { files: ['scrape-loop'], bus: 'drive', volume: crash, release: 0.15 },
  // 車同士の接触 (強さ 50 以上)。強さと自車からの距離で音量を変える
  'crash-car': {
    files: ['crash-car-1', 'crash-car-2', 'crash-car-3'],
    bus: 'drive',
    volume: crash,
    rateJitter: 0.08,
    maxVoices: 4,
  },
  // スリップストリームの効き (fSlip) に比例するループ
  'slipstream-wind-loop': { files: ['slipstream-wind-loop'], bus: 'drive', volume: tyre, release: 0.3 },
  'gear-shift': { files: ['gear-shift-1', 'gear-shift-2'], bus: 'drive', volume: engine, rateJitter: 0.04 },
  // グリッドでアクセルを踏んだとき
  'engine-rev': { files: ['engine-rev-1', 'engine-rev-2'], bus: 'drive', volume: engine, minInterval: 0.4 },

  // 通知
  // drs-open / close は素材が他の短い SE より 8〜11 dB 小さい (sound-list.md の生成記録) ため 2.5 倍にする
  'drs-open': { files: ['drs-open'], bus: 'world', volume: notify * 2.5 },
  'drs-close': { files: ['drs-close'], bus: 'world', volume: notify * 2.5 },
  'lap-complete': { files: ['lap-complete'], bus: 'world', volume: notify },
  'sector-time': { files: ['sector-time'], bus: 'world', volume: notify },
  'sector-best': { files: ['sector-best'], bus: 'world', volume: notify },
  // スタート (game-design.md 7.2 節)
  'start-light-on': { files: ['start-light-on'], bus: 'world', volume: notify },
  'start-go': { files: ['start-go'], bus: 'world', volume: notify },
  'false-start': { files: ['false-start'], bus: 'world', volume: notify },
  'drs-available': { files: ['drs-available'], bus: 'world', volume: notify },
  'final-lap': { files: ['final-lap'], bus: 'world', volume: notify },
  'position-change': { files: ['position-change'], bus: 'world', volume: notify },

  // UI (ポーズ中も鳴る)
  'ui-cursor': { files: ['ui-cursor'], bus: 'ui', volume: ui },
  'ui-confirm': { files: ['ui-confirm'], bus: 'ui', volume: ui },
  'ui-cancel': { files: ['ui-cancel'], bus: 'ui', volume: ui },
  'ui-pause': { files: ['ui-pause'], bus: 'ui', volume: ui },
  'ui-error': { files: ['ui-error'], bus: 'ui', volume: ui },
} satisfies Record<string, SoundDef>;

export type SoundName = keyof typeof soundDefs;
