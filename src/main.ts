import { assetManifest, soundDefs } from './assetList';
import { Game } from './core/Game';
import type { Scene } from './core/Scene';
import { GuestLobbyScene } from './scenes/GuestLobbyScene';
import { HostLobbyScene } from './scenes/HostLobbyScene';
import { RaceScene } from './scenes/RaceScene';
import { loadRaceSetup, newRaceSeed } from './scenes/raceSetup';
import { applyVolumeSettings, loadSettings } from './scenes/settingsStorage';
import { TimeAttackScene } from './scenes/TimeAttackScene';
import { TitleScene } from './scenes/TitleScene';
import { inviteCodeFromHash } from './shared/net/connectionCode';
import { colors } from './ui/colors';
import { drawText, setUiFontImage } from './ui/text';

/**
 * 最初の画面。開発時だけ ?scene=timeattack / ?scene=race で走行画面から始める (headless のスクリーンショット確認用)。
 * race はレース設定の既定値 (CPU 7 台、NORMAL、3 周) で始める。?scene=lobby-host / ?scene=lobby-join はロビー (ホスト / 参加者)
 */
function firstScene(): Scene {
  // 招待リンク (#join=PLO1I.…) で開いたら、タイトル・メニューを飛ばして参加画面に入り、返答コードの作成まで進める
  if (invite) return new GuestLobbyScene(game, null, invite);
  const direct = import.meta.env.DEV ? new URLSearchParams(location.search).get('scene') : null;
  if (direct === 'timeattack') return new TimeAttackScene(game);
  if (direct === 'race') return new RaceScene(game, loadRaceSetup(), newRaceSeed());
  if (direct === 'lobby-host') return new HostLobbyScene(game, null);
  if (direct === 'lobby-join') return new GuestLobbyScene(game, null);
  return new TitleScene(game);
}

/**
 * 招待リンクで開いたときの招待コード。読んだらすぐ URL からフラグメントを消す
 * (再読み込みやブックマークで、使い終わった招待をもう一度使わないように)
 */
function takeInviteFromUrl(): string | null {
  const code = inviteCodeFromHash(location.hash);
  if (location.hash.startsWith('#join=')) history.replaceState(history.state, '', location.pathname + location.search);
  return code;
}

const invite = takeInviteFromUrl();
// ページを開いたままアドレス欄に招待リンクを貼ると、フラグメントだけが変わり読み込み直されない。読み込み直して参加画面に入る
// (ホスト中なら hostGuard の確認が出る)
window.addEventListener('hashchange', () => {
  if (inviteCodeFromHash(location.hash)) location.reload();
});

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
