import { assetManifest, soundDefs } from './assetList';
import { Game } from './core/Game';
import type { Scene } from './core/Scene';
import { GuestLobbyScene } from './scenes/GuestLobbyScene';
import { HostLobbyScene } from './scenes/HostLobbyScene';
import { RaceScene } from './scenes/RaceScene';
import { loadRaceSetup, newRaceSeed } from './scenes/raceSetup';
import { routeInvite } from './scenes/inviteRouter';
import type { Invite } from './scenes/inviteRouter';
import { applyVolumeSettings, loadSettings } from './scenes/settingsStorage';
import { TimeAttackScene } from './scenes/TimeAttackScene';
import { TitleScene } from './scenes/TitleScene';
import { inviteCodeFromHash } from './shared/net/connectionCode';
import { isRoomLinkHash, roomLinkFromHash } from './shared/net/roomLink';
import { colors } from './ui/colors';
import { drawText, setUiFontImage } from './ui/text';
import { drawRotateNotice, drawTouchPad } from './ui/touchPadView';

/**
 * 最初の画面。開発時だけ ?scene=timeattack / ?scene=race で走行画面から始める (headless のスクリーンショット確認用)。
 * race はレース設定の既定値 (CPU 7 台、NORMAL、3 周) で始める。?scene=lobby-host / ?scene=lobby-join はロビー (ホスト / 参加者)
 */
function firstScene(): Scene {
  // 招待リンクで開いたら、タイトル・メニューを飛ばして参加画面に入る
  // (共通リンク #room= は中継経由でそのまま参加、1 人用の #join= は返答コードの作成まで進める)
  if (invite) return new GuestLobbyScene(game, null, invite);
  const direct = import.meta.env.DEV ? new URLSearchParams(location.search).get('scene') : null;
  if (direct === 'timeattack') return new TimeAttackScene(game);
  if (direct === 'race') return new RaceScene(game, loadRaceSetup(), newRaceSeed());
  if (direct === 'lobby-host') return new HostLobbyScene(game, null);
  if (direct === 'lobby-join') return new GuestLobbyScene(game, null);
  return new TitleScene(game);
}

/**
 * 招待リンク (#room= / #join=) で開いたときの招待。読んだらすぐ URL からフラグメントを消す
 * (再読み込みやブックマークで、使い終わった招待をもう一度使わないように。#room= の鍵を履歴に残さないためでもある)
 */
function takeInviteFromUrl(): Invite | null {
  const hash = location.hash;
  if (!hash.startsWith('#join=') && !isRoomLinkHash(hash)) return null;
  history.replaceState(history.state, '', location.pathname + location.search);
  const room = roomLinkFromHash(hash);
  if (room) return { kind: 'room', room };
  const code = inviteCodeFromHash(hash);
  if (code) return { kind: 'code', code };
  showPageNotice('THE INVITE LINK IS BROKEN. ASK THE HOST TO SEND IT AGAIN.');
  return null;
}

/** Canvas の上に短い知らせを数秒出す (シーンが招待を受け取れないとき用) */
function showPageNotice(text: string): void {
  const el = document.createElement('div');
  el.textContent = text;
  el.dataset.testid = 'page-notice';
  const s = el.style;
  s.position = 'fixed';
  s.left = '50%';
  s.top = '12px';
  s.transform = 'translateX(-50%)';
  s.padding = '8px 14px';
  s.background = colors.ink;
  s.color = colors.yellow;
  s.border = `2px solid ${colors.yellow}`;
  s.fontFamily = 'Consolas, "Courier New", monospace';
  s.zIndex = '20';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

let invite = takeInviteFromUrl();
let isLoaded = false;
// ページを開いたままアドレス欄に招待リンクを貼ると、フラグメントだけが変わり読み込み直されない。
// フラグメントはすぐ消し (再読み込みで同じ招待を使わない)、受け取れるシーン (タイトル・メニュー・参加画面) に渡す。
// ロビー・レースの最中は読み込み直さず (接続が切れるため)、知らせだけ出す
window.addEventListener('hashchange', () => {
  const next = takeInviteFromUrl();
  if (!next) return;
  if (!isLoaded) {
    invite = next;
    return;
  }
  if (!routeInvite(next)) showPageNotice('CANNOT JOIN NOW. FINISH OR LEAVE THE RACE / LOBBY, THEN OPEN THE INVITE LINK AGAIN.');
});

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(canvas);
game.touchPad.painter = drawTouchPad;
game.rotateNoticePainter = drawRotateNotice;
// 開発時だけ: ヘッドレスの確認 (画面のボタンの位置・押し下げを読む) 用
if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
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
    isLoaded = true;
    game.changeScene(firstScene());
  });
