import { assetManifest, soundDefs } from './assetList';
import { Game } from './core/Game';
import type { Scene } from './core/Scene';
import { RaceScene } from './scenes/RaceScene';
import { loadRaceSetup, newRaceSeed } from './scenes/raceSetup';
import { applyVolumeSettings, loadSettings } from './scenes/settingsStorage';
import { TimeAttackScene } from './scenes/TimeAttackScene';
import { TitleScene } from './scenes/TitleScene';
import { colors } from './ui/colors';
import { drawText, setUiFontImage } from './ui/text';

/**
 * 最初の画面。開発時だけ ?scene=timeattack / ?scene=race で走行画面から始める (headless のスクリーンショット確認用)。
 * race はレース設定の既定値 (CPU 7 台、NORMAL、3 周) で始める
 */
function firstScene(): Scene {
  const direct = import.meta.env.DEV ? new URLSearchParams(location.search).get('scene') : null;
  if (direct === 'timeattack') return new TimeAttackScene(game);
  if (direct === 'race') return new RaceScene(game, loadRaceSetup(), newRaceSeed());
  return new TitleScene(game);
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(canvas);
game.audio.defineSounds(soundDefs);
applyVolumeSettings(game.audio, loadSettings());

/** 読み込み中の表示 (フォント画像はまだないので、代用フォントで描く) */
let progress = 0;
const loadingScene: Scene = {
  update() {},
  render(ctx) {
    const { width, height } = game;
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, width, height);
    drawText(ctx, `LOADING ${Math.floor(progress * 100)}%`, width / 2, height / 2 - 8, {
      color: colors.text,
      align: 'center',
    });
  },
};
game.changeScene(loadingScene);
game.start();

void game.assets
  .load(assetManifest, game.audio.context, (ratio) => {
    progress = ratio;
  })
  .catch((e: unknown) => console.warn('アセットの読み込み中にエラーが起きました', e))
  .finally(() => {
    // 読めなかったものは代用 (図形・代用フォント・無音) で続ける
    setUiFontImage(game.assets.getImage('ui-font-5x7'));
    game.changeScene(firstScene());
  });
