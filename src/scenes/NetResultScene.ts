import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import type { NetRaceClient } from '../net/NetRaceClient';
import { colors } from '../ui/colors';
import { drawFooterHint, drawMenuList, drawScreenTitle } from '../ui/menuList';
import { closeText } from '../ui/netTexts';
import { drawResultTable, resultRowHeight, resultSummary } from '../ui/resultTable';
import { drawText } from '../ui/text';
import { GuestLobbyScene } from './GuestLobbyScene';
import { HostLobbyScene } from './HostLobbyScene';
import { MenuScene } from './MenuScene';
import { afterRaceInputDelay, menuHint, tappedMenuRow, wasAfterRaceConfirmPressed, wasMenuBackPressed } from './menuKeys';
import { NetRaceScene } from './NetRaceScene';
import type { OnlineLink } from './onlineLink';

const tableTop = 112;

/**
 * オンラインのリザルト (ホストの result)。表は 1 人用と同じ形で、呼び名はプレイヤー名。
 * 決定でロビーに戻る (接続は切らない。network.md「手間を減らす工夫」の 5)。ホストとの接続が切れていたらメニューへ
 */
export class NetResultScene implements Scene {
  /** 表示してから入力を受け付けるまでの残り (秒) */
  private inputDelay = afterRaceInputDelay;

  constructor(
    private readonly game: Game,
    private readonly link: OnlineLink,
    private readonly race: NetRaceClient,
  ) {}

  private get isClosed(): boolean {
    return this.link.session.state === 'closed';
  }

  enter(): void {
    this.game.audio.playBgm('result-theme');
    const session = this.link.session;
    session.onChange = null;
    session.onRaceStart = (race) => this.game.changeScene(new NetRaceScene(this.game, this.link, race));
  }

  exit(): void {
    this.link.session.onRaceStart = null;
  }

  update(dt: number): void {
    if (this.inputDelay > 0) {
      this.inputDelay -= dt;
      return;
    }
    const { input, audio } = this.game;
    const isTapped = tappedMenuRow(this.game, this.listLayout(), 1) >= 0;
    if (!wasAfterRaceConfirmPressed(input) && !wasMenuBackPressed(input) && !isTapped) return;
    audio.playSe('ui-confirm');
    const game = this.game;
    if (this.isClosed) {
      game.changeScene(new MenuScene(game, 'multiplayer'));
      return;
    }
    const link = this.link;
    game.changeScene(link.host ? new HostLobbyScene(game, link.host) : new GuestLobbyScene(game, link.session));
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, width, height);
    drawScreenTitle(ctx, 'RESULT', width / 2, 24);
    const race = this.race;
    const mine = race.results.find((r) => r.isPlayer);
    if (mine) {
      const { text, color } = resultSummary(mine);
      drawText(ctx, text, width / 2, 68, { color, align: 'center' });
    }
    drawResultTable(ctx, race.results, tableTop, width, (r) => race.nameOf(r.carNumber), true);

    const listY = tableTop + 24 + 8 * resultRowHeight + 20;
    if (this.isClosed) {
      drawText(ctx, closeText(this.link.session.closeReason), width / 2, listY, { color: colors.yellow, align: 'center' });
      drawMenuList(ctx, [{ label: 'MENU', isEnabled: true }], 0, this.listLayout());
    } else {
      drawMenuList(ctx, [{ label: 'BACK TO LOBBY', isEnabled: true }], 0, this.listLayout());
    }
    drawFooterHint(ctx, menuHint(this.game, 'ENTER: OK', 'TAP TO CONTINUE'), width / 2, height - 36);
  }

  private listLayout(): { x: number; y: number; width: number } {
    const listY = tableTop + 24 + 8 * resultRowHeight + 20;
    return { x: 260, y: this.isClosed ? listY + 32 : listY, width: 280 };
  }
}
