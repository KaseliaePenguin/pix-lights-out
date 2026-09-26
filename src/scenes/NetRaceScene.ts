import { ControlsReader } from '../core/ControlsReader';
import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import type { NetRaceClient, NetRaceEvent } from '../net/NetRaceClient';
import { clearControls, createControls } from '../shared/controls';
import type { RaceEvent } from '../shared/RaceSession';
import { colors } from '../ui/colors';
import { drawPanel } from '../ui/panel';
import { drawParagraph } from '../ui/paragraph';
import { drawButton } from '../ui/lobbyList';
import { netTexts } from '../ui/netTexts';
import { drawText } from '../ui/text';
import { getCourseTrack } from './courseCache';
import { DevAutopilot } from './devAutopilot';
import { closeHostLobby } from './hostGuard';
import { wasMenuBackPressed, wasMenuConfirmPressed } from './menuKeys';
import { MenuScene } from './MenuScene';
import { NetPauseScene } from './NetPauseScene';
import { NetResultScene } from './NetResultScene';
import type { OnlineLink } from './onlineLink';
import { RaceScreen } from './RaceScreen';
import type { RaceScreenLabels } from './RaceScreen';
import { TitleScene } from './TitleScene';

/** 自分のゴールからリザルトへ進むまで (秒、RaceScene と同じ) */
const finishToResultTime = 3;
/** レース開始時のホストへの注意を出す時間 (秒、network.md「対策」の 7) */
const hostNoticeTime = 3;
/** タブが裏に回っていたと知らせる、隠れていた時間の下限 (ms) */
const hiddenNoticeMs = 3000;
/** 同じ知らせを続けて出さない間隔 (秒) */
const hiddenNoticeCooldown = 5;

/**
 * オンラインの決勝 (network.md「同期方式」「切断時の扱い」)。描画・HUD・音は RaceScreen を 1 人用と共用する。
 * - 名前タグ・順位表はプレイヤー名 (自分は YOU)
 * - ホストだけ、レース開始時に「タブを前面に」の注意を 3 秒。タブが 3 秒以上裏に回っていたら知らせる
 * - Esc のメニューは他の人のレースを止めない (時間は進み、自分の車は操作できない)。参加者のリタイアは接続を切る
 * - ホストとの接続が切れたら「ホストとの接続が切れました。レースを終了します」を出し、OK でタイトルへ
 */
export class NetRaceScene implements Scene {
  private readonly screen: RaceScreen;
  private readonly reader: ControlsReader;
  private readonly controls = createControls();
  private loadingUpdates = 0;
  private isBuilt = false;
  private autopilot: DevAutopilot | null = null;
  private pause: NetPauseScene | null = null;
  private finishTimer = -1;
  private hostNoticeRemaining = 0;
  private isConnectionLost = false;
  private hiddenAt: number | null = null;
  private hiddenNoticeRemaining = 0;
  private readonly onVisibility = () => this.handleVisibility();
  private readonly okRect = { x: 340, y: 330, w: 120, h: 28 };
  private readonly onClick = (e: MouseEvent) => {
    if (!this.isConnectionLost) return;
    const canvas = this.game.canvas;
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * canvas.width;
    const y = ((e.clientY - r.top) / r.height) * canvas.height;
    const o = this.okRect;
    if (x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h) this.goToTitle();
  };

  constructor(
    private readonly game: Game,
    private readonly link: OnlineLink,
    private readonly race: NetRaceClient,
  ) {
    this.reader = ControlsReader.withKeyboard(game.input);
    const labels: RaceScreenLabels = {
      nameTagOf: (rc) => race.nameOf(rc.carNumber),
      abbrOf: (carNumber, isPlayer) => (isPlayer ? 'YOU' : race.nameOf(carNumber).slice(0, 3)),
      isOnTrack: (rc) => race.isOnTrack(rc),
    };
    this.screen = new RaceScreen(game, labels);
  }

  enter(): void {
    this.game.audio.stopBgm(0.3);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.game.canvas.addEventListener('click', this.onClick);
    // 念のため (レース中に次の raceStart は来ない)
    this.link.session.onRaceStart = null;
    this.link.session.onChange = null;
  }

  exit(): void {
    this.screen.stopSounds();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.game.canvas.removeEventListener('click', this.onClick);
  }

  update(dt: number): void {
    if (!this.isBuilt) {
      this.loadingUpdates++;
      if (this.loadingUpdates >= 2) this.build();
      return;
    }
    const { input } = this.game;
    if (this.isConnectionLost) {
      if (wasMenuConfirmPressed(input) || wasMenuBackPressed(input)) this.goToTitle();
      return;
    }
    if (this.pause) this.pause.update(dt);
    else if (this.finishTimer < 0 && wasMenuBackPressed(input)) this.openPause();

    // メニューを開いていても、他の人のレースは止めない (自分の車は操作できない)
    if (this.pause) clearControls(this.controls);
    else if (this.autopilot) this.autopilot.drive(this.race, dt, this.controls);
    else this.reader.read(this.controls);
    for (const e of this.race.step(this.controls, dt)) this.handleEvent(e);
    if (this.isConnectionLost) return;
    // 自分がゴールしたあと、ほかの人のゴール (ホストの結果) を待つ間
    const isWaiting = this.race.player.status !== 'racing' && this.race.phase === 'racing';
    this.screen.messages.setStatus('waitingOthers', isWaiting ? { text: 'WAITING FOR THE OTHER DRIVERS', color: colors.white, priority: 4 } : null);

    if (this.hostNoticeRemaining > 0) {
      this.hostNoticeRemaining -= dt;
      if (this.hostNoticeRemaining <= 0) this.screen.messages.setStatus('hostNotice', null);
    }
    this.hiddenNoticeRemaining = Math.max(0, this.hiddenNoticeRemaining - dt);
    this.screen.update(dt, this.controls, this.reader.lastUsedKind === 'gamepad');

    if (this.finishTimer >= 0) {
      this.finishTimer -= dt;
      if (this.finishTimer <= 0 && this.race.phase === 'finished') this.goToResults();
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    this.screen.render(ctx);
    if (this.isConnectionLost) {
      this.renderConnectionLost(ctx);
      return;
    }
    this.pause?.render(ctx);
  }

  // ---- 準備 ----

  private build(): void {
    this.screen.build(getCourseTrack());
    this.screen.start(this.race);
    this.isBuilt = true;
    if (DevAutopilot.isEnabled()) this.autopilot = new DevAutopilot(this.race.playerId + 1);
    if (this.link.host) {
      this.hostNoticeRemaining = hostNoticeTime;
      this.screen.messages.setStatus('hostNotice', { text: netTexts.hostRaceStart, color: colors.orange, priority: 2 });
    }
    this.game.resetClock();
  }

  // ---- イベント ----

  private handleEvent(e: NetRaceEvent): void {
    const player = this.race.player;
    switch (e.type) {
      case 'connectionLost':
        this.onConnectionLost();
        return;
      case 'carGhosted':
        // 自分の車の状態がホストに 3 秒届かなかった (タブが裏に回っていた)
        if (e.carNumber === player.carNumber && this.hiddenAt === null) this.noticeTabWasHidden();
        return;
      case 'carUnghosted':
      case 'carDisconnected':
        return;
      case 'raceFinished':
        if (this.finishTimer < 0) this.finishTimer = finishToResultTime;
        break;
      case 'resetPlaced':
        if (e.carNumber === player.carNumber) this.autopilot?.resetTracking();
        break;
      default:
        break;
    }
    if (this.screen.handleEvent(e as RaceEvent)) this.finishTimer = finishToResultTime;
  }

  private handleVisibility(): void {
    if (document.hidden) {
      this.hiddenAt = performance.now();
      return;
    }
    const hiddenAt = this.hiddenAt;
    this.hiddenAt = null;
    if (hiddenAt !== null && performance.now() - hiddenAt >= hiddenNoticeMs) this.noticeTabWasHidden();
  }

  private noticeTabWasHidden(): void {
    if (this.hiddenNoticeRemaining > 0 || this.race.phase === 'finished' || this.race.player.status !== 'racing') return;
    this.hiddenNoticeRemaining = hiddenNoticeCooldown;
    this.screen.messages.push({ text: netTexts.tabWasHidden, color: colors.yellow, priority: 2 });
  }

  private onConnectionLost(): void {
    if (this.isConnectionLost) return;
    this.isConnectionLost = true;
    this.pause = null;
    this.screen.stopSounds();
    this.game.audio.stopBgm(0.3);
    this.game.audio.playSe('ui-error');
  }

  // ---- 遷移 ----

  private goToResults(): void {
    this.game.changeScene(new NetResultScene(this.game, this.link, this.race));
  }

  private goToTitle(): void {
    this.game.audio.playSe('ui-confirm');
    this.leaveLink();
    this.game.changeScene(new TitleScene(this.game));
  }

  private leaveLink(): void {
    if (this.link.host) closeHostLobby(this.link.host);
    else this.link.session.leave();
  }

  private openPause(): void {
    const game = this.game;
    this.pause = new NetPauseScene(game, this.link.host !== null, {
      onResume: () => {
        this.pause = null;
      },
      onLeave: () => {
        this.pause = null;
        this.leaveLink();
        game.changeScene(new MenuScene(game, 'multiplayer'));
      },
      onSettingsClosed: () => this.screen.applySettings(),
    });
  }

  // ---- 描画 ----

  private renderConnectionLost(ctx: CanvasRenderingContext2D): void {
    const { width } = this.game;
    const w = 520;
    const h = 150;
    const x = (width - w) / 2;
    const y = 216;
    drawPanel(ctx, x, y, w, h, colors.red);
    drawText(ctx, 'DISCONNECTED', width / 2, y + 16, { color: colors.red, align: 'center' });
    drawParagraph(ctx, netTexts.connectionLost, x + 20, y + 44, w - 40, { color: colors.white, align: 'center' });
    drawButton(ctx, this.okRect, 'OK', true, true);
  }
}
