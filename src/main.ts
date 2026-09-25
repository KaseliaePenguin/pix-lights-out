import { assetManifest, soundDefs } from './assetList';
import { Game } from './core/Game';
import type { Scene } from './core/Scene';
import { applyVolumeSettings, loadSettings } from './scenes/settingsStorage';
import { TitleScene } from './scenes/TitleScene';
import { colors } from './ui/colors';
import { drawText, setUiFontImage } from './ui/text';

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
    game.changeScene(new TitleScene(game));
  });
