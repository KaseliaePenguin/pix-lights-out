import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { HostLobby } from '../host/HostLobby';
import type { HostSlotView } from '../host/HostLobby';
import type { NetProfile } from '../net/NetClientSession';
import type { NetRaceClient } from '../net/NetRaceClient';
import { copyText, readClipboardText } from '../ui/clipboard';
import { colors } from '../ui/colors';
import { drawLobbyList, lobbyListHeight, lobbyRowRect } from '../ui/lobbyList';
import type { LobbyRowView } from '../ui/lobbyList';
import type { MenuItemView } from '../ui/menuList';
import { acceptErrorText, connectFailedLines, netTexts, rejectText, slotFailureLabel } from '../ui/netTexts';
import { drawPanel } from '../ui/panel';
import { drawParagraph } from '../ui/paragraph';
import { teamOf } from '../ui/teams';
import { drawText } from '../ui/text';
import { getCourseTrack } from './courseCache';
import { closeHostLobby, guardHostTab } from './hostGuard';
import { LobbyUi } from './LobbyUi';
import { moveMenuCursor, wasMenuBackPressed, wasMenuConfirmPressed, wasMenuDownPressed, wasMenuLeftPressed, wasMenuRightPressed, wasMenuUpPressed } from './menuKeys';
import { MultiplayerScene } from './MultiplayerScene';
import { NetRaceScene } from './NetRaceScene';
import { loadNetProfile, saveNetProfile } from './netProfile';
import { lapChoicesOnline, nextFreeTeam } from './lobbyRules';

type HostItem = 'name' | 'team' | 'ready' | 'laps' | 'invite' | 'slot' | 'paste' | 'start' | 'close';

const items: readonly HostItem[] = ['name', 'team', 'ready', 'laps', 'invite', 'slot', 'paste', 'start', 'close'];
const labels: Record<HostItem, string> = {
  name: 'NAME',
  team: 'TEAM',
  ready: 'READY',
  laps: 'LAPS',
  invite: 'ISSUE INVITE CODE',
  slot: 'SLOT',
  paste: 'PASTE REPLY',
  start: 'START RACE',
  close: 'CLOSE LOBBY',
};

const menuX = 12;
const menuY = 56;
const menuW = 320;
const menuRowH = 26;
const listX = 344;
const listY = 56;
const listW = 444;
const codeX = 12;
const codeY = 298;
const codeW = 776;
const codeH = 204;
const buttonW = 136;
const buttonX = codeX + codeW - buttonW - 10;
/** ロビーを閉じる操作を確かめる時間 (秒)。参加者がいるときは 2 回押してもらう */
const closeConfirmTime = 3;
/** START を押してから、ホスト本人の準備完了が届くのを待つ時間 (秒) */
const startWaitTime = 2;

/**
 * ロビー (ホスト、network.md「ホストの画面」)。参加者一覧 8 枠、招待コードの発行・コピー、返答コードの貼り付け (どこでも Ctrl+V)、
 * 枠の取り消し、[詳細をコピー]、周回数、スタート。招待コード・貼り付け・名前は Canvas に重ねた DOM で扱う。
 * lobby を渡すとそのロビーに戻る (リザルトから)。null なら新しく作る。
 */
export class HostLobbyScene implements Scene {
  private lobby: HostLobby | null;
  private ui: LobbyUi | null = null;
  private inviteBox: HTMLTextAreaElement | null = null;
  private profile: NetProfile;
  private selected = 0;
  /** 招待コード欄に出している枠 (1〜7) */
  private viewSlot = 1;
  private loadingUpdates = 0;
  private closeConfirmRemaining = 0;
  private startWaitRemaining = 0;
  private isAwaitingJoin = false;
  private isCheckingCode = false;
  /** 枠ごとの前回の状態 (参加・失敗・退出の知らせを出すため)。枠 1〜7 → 状態と参加者名 */
  private readonly lastSlotStates = new Map<number, string>();

  constructor(
    private readonly game: Game,
    lobby: HostLobby | null,
  ) {
    this.lobby = lobby;
    this.profile = lobby ? { ...lobby.session.profile } : loadNetProfile();
    if (lobby) this.selected = items.indexOf('ready');
  }

  enter(): void {
    this.game.audio.playBgm('menu-theme');
    this.ui = new LobbyUi(this.game, {
      onPaste: (text) => void this.acceptReply(text),
      onNameCommit: (name) => this.commitName(name),
      nameRect: { x: menuX + 170, y: menuY + 1, w: 150, h: 22 },
    });
    this.ui.showName(this.profile.name);
    this.inviteBox = this.ui.overlay.addCodeBox('invite-code', { x: codeX + 10, y: codeY + 30, w: buttonX - codeX - 20, h: 60 });
    this.ui.overlay.addPasteBox(
      'paste-input',
      { x: menuX + 190, y: menuY + items.indexOf('paste') * menuRowH + 1, w: 130, h: 22 },
      'CTRL+V',
      (text) => void this.acceptReply(text),
    );
    this.ui.overlay.setVisible(this.inviteBox, false);
    if (this.lobby) this.attach(this.lobby);
  }

  exit(): void {
    this.ui?.destroy();
    this.ui = null;
    if (this.lobby) {
      this.lobby.onChange = null;
      this.lobby.session.onChange = null;
    }
  }

  update(dt: number): void {
    const ui = this.ui;
    if (!ui) return;
    if (!this.lobby) {
      // コースを作る間 (約 0.5 秒) 画面が止まるので、LOADING を描いてから作る
      this.loadingUpdates++;
      if (this.loadingUpdates >= 2) this.create();
      return;
    }
    const lobby = this.lobby;
    ui.update(dt);
    this.closeConfirmRemaining = Math.max(0, this.closeConfirmRemaining - dt);
    this.updateStart(lobby, dt);
    if (lobby.session.state === 'closed') {
      // ホスト本人の接続 (MessagePort) が切れることは通常ない。念のためロビーを閉じて戻る
      closeHostLobby(lobby);
      this.game.changeScene(new MultiplayerScene(this.game, 'host'));
      return;
    }
    if (ui.isEditingName) return;

    const { input, audio } = this.game;
    const item = items[this.selected];
    if (wasMenuUpPressed(input)) {
      this.selected = moveMenuCursor(this.selected, -1, items.length);
      audio.playSe('ui-cursor');
    } else if (wasMenuDownPressed(input)) {
      this.selected = moveMenuCursor(this.selected, 1, items.length);
      audio.playSe('ui-cursor');
    } else if (wasMenuLeftPressed(input)) {
      this.change(item, -1);
    } else if (wasMenuRightPressed(input)) {
      this.change(item, 1);
    } else if (wasMenuConfirmPressed(input)) {
      this.confirm(item);
    } else if (wasMenuBackPressed(input)) {
      this.confirm('close');
    } else if (input.wasPressed('Delete') && item === 'slot') {
      this.cancelSlot();
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, width, height);
    const ui = this.ui;
    const lobby = this.lobby;
    if (!ui || !lobby) {
      drawText(ctx, 'CREATING LOBBY', width / 2, height / 2 - 8, { color: colors.text, align: 'center' });
      return;
    }
    ui.beginRender();
    drawText(ctx, 'HOST LOBBY', 12, 12, { scale: 4, color: colors.white });
    drawText(ctx, 'CTRL+V ANYWHERE: PASTE A REPLY CODE', width - 12, 22, { color: colors.subtext, align: 'right' });

    this.renderMenu(ctx, ui, lobby);
    this.renderList(ctx, ui, lobby);
    this.renderCodePanel(ctx, ui, lobby);
    drawParagraph(ctx, netTexts.hostNotice, 12, 510, 776, { color: colors.orange });
    ui.drawToast(ctx, 12, 556, 776);
  }

  // ---- 準備 ----

  private create(): void {
    // 開発用: ?laps=1 で周回数の初期値を変える (ヘッドレスの確認で早く終えるため)
    const devLaps = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get('laps')) : 0;
    const lobby = HostLobby.create(this.profile, getCourseTrack(), { laps: devLaps > 0 ? devLaps : 3 });
    this.lobby = lobby;
    guardHostTab(lobby);
    this.attach(lobby);
    this.game.resetClock();
  }

  private attach(lobby: HostLobby): void {
    // 今の枠の状態を覚えておく (ここからの変化だけを知らせる)
    this.noticeSlotChanges(lobby);
    lobby.onChange = () => this.onLobbyChange();
    lobby.session.onChange = () => this.onLobbyChange();
    lobby.session.onRaceStart = (race) => this.onRaceStart(lobby, race);
  }

  private onLobbyChange(): void {
    const lobby = this.lobby;
    if (!lobby) return;
    const session = lobby.session;
    this.noticeSlotChanges(lobby);
    if (this.isAwaitingJoin) {
      if (session.rejectReason) {
        // 名前・チームの変更を断られた: 表示を今の自分に戻す
        this.isAwaitingJoin = false;
        this.ui?.toast(rejectText(session.rejectReason));
        this.game.audio.playSe('ui-error');
        const me = session.me;
        if (me) this.profile = { name: me.name, team: me.team };
        this.ui?.showName(this.profile.name);
      } else if (session.me && session.me.name === this.profile.name && session.me.team === this.profile.team) {
        this.isAwaitingJoin = false;
        saveNetProfile(this.profile);
      }
    }
  }

  /** 枠の状態が変わったら、画面下の知らせ (貼り付けの結果など) を今の状態に書き換える */
  private noticeSlotChanges(lobby: HostLobby): void {
    const players = lobby.session.players;
    for (const view of lobby.slots) {
      const player = players.find((p) => p.id === view.slot);
      const key = view.state === 'joined' && player ? `joined:${player.name}` : view.state;
      const before = this.lastSlotStates.get(view.slot);
      this.lastSlotStates.set(view.slot, key);
      // 初めて見る枠 (ロビーに戻ってきたとき) は知らせない
      if (before === undefined || before === key) continue;
      const slot = view.slot;
      if (key.startsWith('joined:') && player) {
        this.ui?.toast(`SLOT ${slot}: ${player.name} JOINED.`, colors.hudGreen);
        this.game.audio.playSe('ui-confirm');
      } else if (view.state === 'joined') {
        this.ui?.toast(`SLOT ${slot}: CONNECTED. WAITING FOR THE PLAYER TO JOIN...`, colors.text);
      } else if (view.state === 'failed') {
        this.ui?.toast(`SLOT ${slot}: FAILED (${slotFailureLabel(view.failure)}). SEE THE SLOT FOR DETAILS.`, colors.red);
        this.game.audio.playSe('ui-error');
      } else if (view.state === 'empty' && before.startsWith('joined')) {
        this.ui?.toast(`SLOT ${slot}: THE PLAYER LEFT.`, colors.text);
      }
    }
  }

  private onRaceStart(lobby: HostLobby, race: NetRaceClient): void {
    this.game.changeScene(new NetRaceScene(this.game, { session: lobby.session, host: lobby }, race));
  }

  // ---- 操作 ----

  private change(item: HostItem, step: number): void {
    const lobby = this.lobby;
    if (!lobby) return;
    const audio = this.game.audio;
    switch (item) {
      case 'team':
        this.changeTeam(step);
        break;
      case 'laps': {
        const laps = this.currentLaps(lobby);
        const i = Math.max(0, lapChoicesOnline.indexOf(laps));
        const next = lapChoicesOnline[(i + step + lapChoicesOnline.length) % lapChoicesOnline.length];
        lobby.setLaps(next);
        audio.playSe('ui-cursor');
        break;
      }
      case 'slot':
        this.viewSlot = ((this.viewSlot - 1 + step + 7) % 7) + 1;
        audio.playSe('ui-cursor');
        break;
      case 'ready':
        this.toggleReady();
        break;
      default:
        break;
    }
  }

  private confirm(item: HostItem): void {
    const lobby = this.lobby;
    if (!lobby) return;
    const audio = this.game.audio;
    switch (item) {
      case 'name':
        audio.playSe('ui-confirm');
        this.ui?.focusName();
        break;
      case 'team':
      case 'laps':
      case 'ready':
        this.change(item, 1);
        break;
      case 'invite':
        void this.issueInvite();
        break;
      case 'slot':
        this.slotAction();
        break;
      case 'paste':
        void this.pasteFromClipboard();
        break;
      case 'start':
        this.requestStart();
        break;
      case 'close':
        this.requestClose(lobby);
        break;
    }
  }

  private selectAndConfirm(index: number): void {
    if (this.ui?.isEditingName) return;
    this.selected = index;
    this.confirm(items[index]);
  }

  private commitName(text: string): void {
    const lobby = this.lobby;
    const name = text.trim();
    if (name === this.profile.name) return;
    if (!/^[A-Z0-9]{3,8}$/.test(name)) {
      this.ui?.toast(rejectText('invalidName'));
      this.game.audio.playSe('ui-error');
      this.ui?.showName(this.profile.name);
      return;
    }
    if (lobby?.session.players.some((p) => p.id !== lobby.session.playerId && p.name === name)) {
      this.ui?.toast(rejectText('nameTaken'));
      this.game.audio.playSe('ui-error');
      this.ui?.showName(this.profile.name);
      return;
    }
    this.profile = { ...this.profile, name };
    this.rejoin();
    this.game.audio.playSe('ui-confirm');
  }

  private changeTeam(step: number): void {
    const lobby = this.lobby;
    if (!lobby) return;
    const session = lobby.session;
    const taken = session.players.filter((p) => p.id !== session.playerId).map((p) => p.team);
    const team = nextFreeTeam(this.profile.team, step, taken);
    if (team === this.profile.team) {
      this.game.audio.playSe('ui-error');
      return;
    }
    this.profile = { ...this.profile, team };
    this.rejoin();
    this.game.audio.playSe('ui-cursor');
  }

  /** 名前・チームを変えて join し直す (ホストの判定で重複なら断られる) */
  private rejoin(): void {
    const lobby = this.lobby;
    if (!lobby) return;
    lobby.session.rejectReason = null;
    this.isAwaitingJoin = true;
    lobby.session.join(this.profile);
  }

  private toggleReady(): void {
    const session = this.lobby?.session;
    if (!session || session.state !== 'lobby') return;
    session.setReady(!(session.me?.isReady ?? false));
    this.game.audio.playSe('ui-confirm');
  }

  private async issueInvite(): Promise<void> {
    const lobby = this.lobby;
    if (!lobby) return;
    const audio = this.game.audio;
    const free = lobby.slots.find((s) => s.state === 'empty' || s.state === 'failed');
    if (!free) {
      audio.playSe('ui-error');
      this.ui?.toast('NO OPEN SLOT. THE LOBBY IS FULL (8 PLAYERS).');
      return;
    }
    audio.playSe('ui-confirm');
    this.viewSlot = free.slot;
    const view = await lobby.issueInvite();
    if (!view || this.lobby !== lobby) return;
    this.viewSlot = view.slot;
    if (view.state === 'inviting') this.ui?.toast(`SLOT ${view.slot}: INVITE CODE READY. COPY IT AND SEND IT TO THE PLAYER.`, colors.hudGreen);
  }

  /** 枠の欄で決定: 招待中ならコードをコピー、失敗なら詳細をコピー、空きなら招待コードを発行 */
  private slotAction(): void {
    const view = this.lobby?.slot(this.viewSlot);
    if (!view) return;
    if (view.state === 'inviting') void this.copyInvite(view);
    else if (view.state === 'failed') void this.copyDetails();
    else if (view.state === 'empty') void this.issueInvite();
    else this.game.audio.playSe('ui-error');
  }

  private async copyInvite(view: HostSlotView): Promise<void> {
    if (!view.code) return;
    const ok = await copyText(view.code, this.inviteBox);
    this.game.audio.playSe(ok ? 'ui-confirm' : 'ui-error');
    this.ui?.toast(
      ok ? `SLOT ${view.slot}: INVITE CODE COPIED.` : 'COULD NOT COPY. SELECT THE CODE IN THE BOX AND PRESS CTRL+C.',
      ok ? colors.hudGreen : colors.yellow,
    );
  }

  private async copyDetails(): Promise<void> {
    const d = this.lobby?.diagnosticsOf(this.viewSlot);
    if (!d) return;
    const ok = await copyText(JSON.stringify({ game: 'PIX LIGHTS OUT', ...d }, null, 1), null);
    this.game.audio.playSe(ok ? 'ui-confirm' : 'ui-error');
    this.ui?.toast(ok ? 'DETAILS COPIED (NO IP ADDRESSES).' : 'COULD NOT COPY THE DETAILS.', ok ? colors.hudGreen : colors.yellow);
  }

  private cancelSlot(): void {
    const lobby = this.lobby;
    const view = lobby?.slot(this.viewSlot);
    if (!lobby || !view) return;
    if (view.state === 'joined' || view.state === 'empty' || view.state === 'connecting') {
      this.game.audio.playSe('ui-error');
      return;
    }
    lobby.cancelInvite(this.viewSlot);
    this.game.audio.playSe('ui-cancel');
    this.ui?.toast(`SLOT ${this.viewSlot}: CANCELLED. THE CODE CAN NO LONGER BE USED.`, colors.text);
  }

  private async pasteFromClipboard(): Promise<void> {
    const text = await readClipboardText();
    if (text === null || text.trim() === '') {
      this.game.audio.playSe('ui-error');
      this.ui?.toast('COULD NOT READ THE CLIPBOARD. PRESS CTRL+V, OR PASTE INTO THE BOX.');
      return;
    }
    await this.acceptReply(text);
  }

  private async acceptReply(text: string): Promise<void> {
    const lobby = this.lobby;
    if (!lobby || this.isCheckingCode) return;
    this.isCheckingCode = true;
    try {
      const r = await lobby.acceptReply(text);
      if (this.lobby !== lobby) return;
      if (r.slot !== null) this.viewSlot = r.slot;
      if (r.ok) {
        this.game.audio.playSe('ui-confirm');
        this.ui?.toast(`SLOT ${r.slot}: REPLY CODE ACCEPTED. CONNECTING...`, colors.hudGreen);
      } else {
        this.game.audio.playSe('ui-error');
        this.ui?.toast(acceptErrorText(r.error));
      }
    } finally {
      this.isCheckingCode = false;
    }
  }

  private requestStart(): void {
    const lobby = this.lobby;
    if (!lobby) return;
    const session = lobby.session;
    const others = session.players.filter((p) => p.id !== session.playerId);
    if (lobby.status?.phase === 'race' || others.some((p) => !p.isReady)) {
      this.game.audio.playSe('ui-error');
      this.ui?.toast('WAITING FOR ALL PLAYERS TO BE READY.');
      return;
    }
    this.game.audio.playSe('ui-confirm');
    // ホスト本人も準備完了にしてから始める (Worker に届いてから)
    if (!session.me?.isReady) session.setReady(true);
    this.startWaitRemaining = startWaitTime;
  }

  private updateStart(lobby: HostLobby, dt: number): void {
    if (this.startWaitRemaining <= 0) return;
    this.startWaitRemaining -= dt;
    if (lobby.status?.canStart) {
      this.startWaitRemaining = 0;
      void lobby.startRace().then((result) => {
        if (result !== 'ok' && this.lobby === lobby) {
          this.game.audio.playSe('ui-error');
          this.ui?.toast(result === 'notReady' ? 'WAITING FOR ALL PLAYERS TO BE READY.' : 'COULD NOT START THE RACE.');
        }
      });
    } else if (this.startWaitRemaining <= 0) {
      this.game.audio.playSe('ui-error');
      this.ui?.toast('WAITING FOR ALL PLAYERS TO BE READY.');
    }
  }

  private requestClose(lobby: HostLobby): void {
    if (lobby.hasGuests && this.closeConfirmRemaining <= 0) {
      this.closeConfirmRemaining = closeConfirmTime;
      this.game.audio.playSe('ui-error');
      this.ui?.toast('PLAYERS ARE CONNECTED. PRESS AGAIN TO CLOSE THE LOBBY FOR EVERYONE.');
      return;
    }
    this.game.audio.playSe('ui-cancel');
    closeHostLobby(lobby);
    this.lobby = null;
    this.game.changeScene(new MultiplayerScene(this.game, 'host'));
  }

  private currentLaps(lobby: HostLobby): number {
    return lobby.status?.settings.laps ?? lobby.session.settings?.laps ?? 3;
  }

  // ---- 描画 ----

  private renderMenu(ctx: CanvasRenderingContext2D, ui: LobbyUi, lobby: HostLobby): void {
    const session = lobby.session;
    const others = session.players.filter((p) => p.id !== session.playerId);
    const canStart = lobby.status?.phase !== 'race' && others.every((p) => p.isReady);
    const team = teamOf(this.profile.team);
    const views: MenuItemView[] = items.map((item) => {
      switch (item) {
        case 'name':
          return { label: labels.name, isEnabled: true };
        case 'team':
          return { label: labels.team, isEnabled: true, value: `${team.carNumber} ${team.abbr}` };
        case 'ready':
          return { label: labels.ready, isEnabled: true, value: session.me?.isReady ? 'YES' : 'NO' };
        case 'laps':
          return { label: labels.laps, isEnabled: true, value: String(this.currentLaps(lobby)) };
        case 'slot':
          return { label: labels.slot, isEnabled: true, value: String(this.viewSlot) };
        case 'start':
          return { label: labels.start, isEnabled: canStart };
        case 'paste':
          return { label: labels.paste, isEnabled: true };
        default:
          return { label: labels[item], isEnabled: true };
      }
    });
    drawPanel(ctx, menuX - 4, menuY - 4, menuW + 8, items.length * menuRowH + 4);
    ui.drawMenu(ctx, views, this.selected, { x: menuX, y: menuY, width: menuW, rowHeight: menuRowH }, (i) => this.selectAndConfirm(i));
  }

  private renderList(ctx: CanvasRenderingContext2D, ui: LobbyUi, lobby: HostLobby): void {
    const session = lobby.session;
    const rows: LobbyRowView[] = [];
    rows.push({
      slot: 0,
      player: session.me,
      status: 'JOINING...',
      statusColor: colors.midGrey,
      isSelf: true,
      isSelected: false,
    });
    for (const s of lobby.slots) {
      const player = session.players.find((p) => p.id === s.slot) ?? null;
      const row: LobbyRowView = { slot: s.slot, player, status: '', statusColor: colors.midGrey, isSelf: false, isSelected: s.slot === this.viewSlot };
      switch (s.state) {
        case 'empty':
          row.status = 'OPEN';
          break;
        case 'preparing':
          row.status = 'PREPARING CODE...';
          row.statusColor = colors.text;
          break;
        case 'inviting':
          row.status = `INVITED  ${formatRemaining(s.remainingMs ?? 0)}`;
          row.statusColor = colors.cyan;
          break;
        case 'connecting':
          row.status = 'CONNECTING...';
          row.statusColor = colors.text;
          break;
        case 'joined':
          row.status = 'JOINING...';
          row.statusColor = colors.text;
          break;
        case 'failed':
          row.status = `FAILED: ${slotFailureLabel(s.failure)}`;
          row.statusColor = colors.red;
          break;
      }
      rows.push(row);
    }
    const count = session.players.length;
    drawLobbyList(ctx, listX, listY, listW, `PLAYERS ${count}/8`, rows);
    for (let i = 1; i < rows.length; i++) {
      const slot = rows[i].slot;
      ui.clicks.add(lobbyRowRect(listX + 4, listY, listW - 8, i), () => {
        this.viewSlot = slot;
        this.selected = items.indexOf('slot');
        this.game.audio.playSe('ui-cursor');
      });
    }
    const y = listY + lobbyListHeight(rows.length) + 2;
    drawText(ctx, `COURSE 1   LAPS ${this.currentLaps(lobby)}`, listX + 8, y, { color: colors.subtext });
  }

  private renderCodePanel(ctx: CanvasRenderingContext2D, ui: LobbyUi, lobby: HostLobby): void {
    drawPanel(ctx, codeX, codeY, codeW, codeH);
    const view = lobby.slot(this.viewSlot);
    const inviteBox = this.inviteBox;
    const showCode = view?.state === 'inviting' && view.code !== null;
    if (inviteBox) {
      ui.overlay.setVisible(inviteBox, showCode);
      if (showCode && inviteBox.value !== view.code) inviteBox.value = view.code ?? '';
    }
    if (!view) return;
    const x = codeX + 10;
    const y = codeY + 8;
    const w = codeW - 20;
    const slot = view.slot;
    const player = lobby.session.players.find((p) => p.id === slot);
    switch (view.state) {
      case 'empty':
        drawText(ctx, `SLOT ${slot}: OPEN`, x, y, { color: colors.white });
        drawParagraph(
          ctx,
          [
            'SELECT "ISSUE INVITE CODE" TO MAKE A CODE FOR THE NEXT OPEN SLOT. YOU CAN ISSUE CODES FOR SEVERAL PLAYERS AT ONCE.',
            'EACH PLAYER PASTES THEIR CODE AND SENDS A REPLY CODE BACK. PASTE THE REPLY CODES HERE WITH CTRL+V, IN ANY ORDER.',
          ],
          x, y + 28, w, { color: colors.text },
        );
        break;
      case 'preparing':
        drawText(ctx, `SLOT ${slot}: PREPARING THE INVITE CODE... (UP TO 5 SEC)`, x, y, { color: colors.white });
        break;
      case 'inviting': {
        drawText(ctx, `SLOT ${slot} INVITE CODE`, x, y, { color: colors.white });
        drawText(ctx, `EXPIRES IN ${formatRemaining(view.remainingMs ?? 0)}`, codeX + codeW - 10, y, { color: colors.subtext, align: 'right' });
        ui.button(ctx, { x: buttonX, y: codeY + 30, w: buttonW, h: 26 }, 'COPY', true, () => void this.copyInvite(view));
        ui.button(ctx, { x: buttonX, y: codeY + 62, w: buttonW, h: 26 }, 'CANCEL', true, () => this.cancelSlot());
        let ny = codeY + 98;
        ny += drawParagraph(ctx, netTexts.ipWarning, x, ny, w, { color: colors.subtext }) + 4;
        const gather = view.gather?.analysis;
        if (gather?.isStunUnreachable) ny += drawParagraph(ctx, netTexts.stunUnreachable, x, ny, w, { color: colors.yellow, maxLines: 2 });
        else if (gather?.isSymmetricNatSuspected) drawParagraph(ctx, netTexts.symmetricNat, x, ny, w, { color: colors.yellow, maxLines: 2 });
        break;
      }
      case 'connecting':
        drawText(ctx, `SLOT ${slot}: CONNECTING... (UP TO 15 SEC)`, x, y, { color: colors.white });
        break;
      case 'joined':
        drawText(ctx, player ? `SLOT ${slot}: ${player.name} JOINED` : `SLOT ${slot}: CONNECTED. WAITING FOR THE PLAYER TO JOIN...`, x, y, {
          color: colors.white,
        });
        break;
      case 'failed': {
        drawText(ctx, `SLOT ${slot}: FAILED (${slotFailureLabel(view.failure)})`, x, y, { color: colors.red });
        const by = codeY + codeH - 34;
        ui.button(ctx, { x: buttonX - buttonW - 10, y: by, w: buttonW, h: 26 }, 'COPY DETAILS', true, () => void this.copyDetails());
        ui.button(ctx, { x: buttonX, y: by, w: buttonW, h: 26 }, 'CLEAR', true, () => this.cancelSlot());
        const lines =
          view.failure === 'expired'
            ? [netTexts.expired]
            : view.failure === 'gatherFailed'
              ? ['COULD NOT MAKE AN INVITE CODE. TRY AGAIN.']
              : connectFailedLines(lobby.diagnosticsOf(slot)?.isSamePublicAddress === true);
        drawParagraph(ctx, lines, x, y + 24, w, { color: colors.text, maxLines: 7 });
        break;
      }
    }
    const gather = view.gather?.analysis;
    const hasWarning = view.state === 'inviting' && (gather?.isStunUnreachable || gather?.isSymmetricNatSuspected);
    if ((view.state === 'inviting' && !hasWarning) || view.state === 'failed') {
      drawText(ctx, 'ON "SLOT": ENTER = COPY, DEL = CANCEL', x, codeY + codeH - 24, { color: colors.midGrey });
    }
  }
}

/** 残り時間 m:ss */
function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
