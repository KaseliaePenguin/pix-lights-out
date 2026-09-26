import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { HostLobby } from '../host/HostLobby';
import type { HostSlotView } from '../host/HostLobby';
import type { NetProfile } from '../net/NetClientSession';
import type { NetRaceClient } from '../net/NetRaceClient';
import { inviteLinkOf } from '../shared/net/connectionCode';
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
import { clearInviteHandler, setInviteHandler } from './inviteRouter';
import { LobbyUi } from './LobbyUi';
import { moveMenuCursor, wasMenuBackPressed, wasMenuConfirmPressed, wasMenuDownPressed, wasMenuLeftPressed, wasMenuRightPressed, wasMenuUpPressed } from './menuKeys';
import { MultiplayerScene } from './MultiplayerScene';
import { NetRaceScene } from './NetRaceScene';
import { loadNetProfile, saveNetProfile } from './netProfile';
import { lapChoicesOnline, nextFreeTeam } from './lobbyRules';

type HostItem = 'invite' | 'start' | 'paste' | 'slot' | 'name' | 'team' | 'laps' | 'close';

/** よく使う順 (招待 → スタート)。ホスト本人の準備完了は START RACE で自動で付ける */
const items: readonly HostItem[] = ['invite', 'start', 'paste', 'slot', 'name', 'team', 'laps', 'close'];
const labels: Record<HostItem, string> = {
  invite: 'NEW INVITE',
  start: 'START RACE',
  paste: 'PASTE REPLY',
  slot: 'SLOT',
  name: 'NAME',
  team: 'TEAM',
  laps: 'LAPS',
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
/** 大きなコピーの案内の枠 */
const promptRect = { x: codeX + 10, y: codeY + 8, w: codeW - 20, h: 52 };
/** ロビーを閉じる操作を確かめる時間 (秒)。参加者がいるときは 2 回押してもらう */
const closeConfirmTime = 3;
/** START を押してから、ホスト本人の準備完了が届くのを待つ時間 (秒) */
const startWaitTime = 2;

/**
 * ロビー (ホスト、network.md「ホストの画面」)。参加者一覧 8 枠、招待リンクの発行・コピー、返答コードの貼り付け (どこでも Ctrl+V)、
 * 枠の取り消し、[詳細をコピー]、周回数、スタート。ロビーを作った直後に枠 1 の招待を自動で発行し、できたら自動でコピーを試す
 * (できなければ「ENTER でコピー」の大きな案内)。招待リンク・貼り付け・名前は Canvas に重ねた DOM で扱う。
 * lobby を渡すとそのロビーに戻る (リザルトから)。null なら新しく作る。
 */
export class HostLobbyScene implements Scene {
  private lobby: HostLobby | null;
  private ui: LobbyUi | null = null;
  private inviteBox: HTMLTextAreaElement | null = null;
  private profile: NetProfile;
  private selected = 0;
  /** 招待リンク欄に出している枠 (1〜7) */
  private viewSlot = 1;
  private loadingUpdates = 0;
  private closeConfirmRemaining = 0;
  private startWaitRemaining = 0;
  private isAwaitingJoin = false;
  private isCheckingCode = false;
  /** 招待を作っている (発行はユーザー操作のあと最大 5 秒かかる) */
  private isIssuing = false;
  /** 今の招待リンクをコピーした枠 (新しく発行したら外す) */
  private readonly copiedSlots = new Set<number>();
  /** 枠ごとの前回の状態 (参加・失敗・退出の知らせを出すため)。枠 1〜7 → 状態と参加者名 */
  private readonly lastSlotStates = new Map<number, string>();

  constructor(
    private readonly game: Game,
    lobby: HostLobby | null,
  ) {
    this.lobby = lobby;
    this.profile = lobby ? { ...lobby.session.profile } : loadNetProfile();
    if (lobby) this.selected = items.indexOf('start');
  }

  /** 開いたまま招待リンクを開いた (自分の招待を開いた場合など): ホスト中は参加できないので知らせだけ */
  private readonly onInvite = () => {
    this.game.audio.playSe('ui-error');
    this.ui?.toast('YOU ARE HOSTING, SO YOU CANNOT JOIN ANOTHER LOBBY HERE. SEND THE INVITE LINK TO A FRIEND.');
  };

  enter(): void {
    this.game.audio.playBgm('menu-theme');
    setInviteHandler(this.onInvite);
    this.ui = new LobbyUi(this.game, {
      onPaste: (text) => void this.acceptReply(text),
      onNameCommit: (name) => this.commitName(name),
      nameRect: { x: menuX + 170, y: menuY + items.indexOf('name') * menuRowH + 1, w: 150, h: 22 },
    });
    this.ui.showName(this.profile.name);
    this.inviteBox = this.ui.overlay.addCodeBox('invite-code', { x: codeX + 10, y: codeY + 66, w: buttonX - buttonW - codeX - 30, h: 32 });
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
    clearInviteHandler(this.onInvite);
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
    drawText(ctx, 'HOST LOBBY', 12, 6, { scale: 3, color: colors.white });
    drawText(ctx, 'CTRL+V ANYWHERE: PASTE A REPLY CODE', width - 12, 12, { color: colors.subtext, align: 'right' });
    ui.drawHint(ctx, this.hint(lobby));

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
    // 最初の招待 (枠 1) はすぐ作り始める (ロビーを作る = 誰かを招待する、なので)
    void this.issueInvite(true);
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
        // 待っている招待がなければ、次にすることはスタート
        if (!before.startsWith('joined:') && !this.isIssuing && !this.ui?.isEditingName && !this.hasPendingInvite(lobby)) {
          this.selected = items.indexOf('start');
        }
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

  private hasPendingInvite(lobby: HostLobby): boolean {
    return lobby.slots.some((s) => s.state === 'preparing' || s.state === 'inviting' || s.state === 'connecting');
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
        this.change(item, 1);
        break;
      case 'invite':
        this.inviteAction();
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

  /** 招待の項目で決定: 今の招待をまだコピーしていなければコピー、コピー済みなら次の招待を作る */
  private inviteAction(): void {
    const view = this.lobby?.slot(this.viewSlot);
    if (view?.state === 'inviting' && !this.copiedSlots.has(view.slot)) {
      void this.copyInvite(view);
      return;
    }
    if (this.isIssuing) {
      this.game.audio.playSe('ui-error');
      this.ui?.toast('PREPARING THE INVITE LINK. WAIT A MOMENT.', colors.text);
      return;
    }
    void this.issueInvite(false);
  }

  /** isAuto = ロビーを作った直後の自動の発行 */
  private async issueInvite(isAuto: boolean): Promise<void> {
    const lobby = this.lobby;
    if (!lobby || this.isIssuing) return;
    const audio = this.game.audio;
    const slots = lobby.slots;
    // HostLobby.issueInvite と同じ順 (空き → 失敗) で次に使う枠を選び、準備中の表示をその枠に合わせる
    const free = slots.find((s) => s.state === 'empty') ?? slots.find((s) => s.state === 'failed');
    if (!free) {
      audio.playSe('ui-error');
      this.ui?.toast('NO OPEN SLOT. THE LOBBY IS FULL (8 PLAYERS).');
      return;
    }
    if (!isAuto) audio.playSe('ui-confirm');
    this.isIssuing = true;
    this.viewSlot = free.slot;
    this.copiedSlots.delete(free.slot);
    let view: HostSlotView | null = null;
    try {
      view = await lobby.issueInvite();
    } finally {
      this.isIssuing = false;
    }
    if (!view || this.lobby !== lobby || !this.ui) return;
    this.viewSlot = view.slot;
    if (view.state !== 'inviting') return;
    this.copiedSlots.delete(view.slot);
    if (!this.ui.isEditingName) this.selected = items.indexOf('invite');
    // コピーできる環境 (ページにフォーカスがあるなど) なら自動でコピーする。できなければ「ENTER でコピー」の案内のまま
    await this.copyInvite(view, true);
  }

  /** 枠の欄で決定: 招待中ならリンクをコピー、失敗なら詳細をコピー、空きなら招待を作る */
  private slotAction(): void {
    const view = this.lobby?.slot(this.viewSlot);
    if (!view) return;
    if (view.state === 'inviting') void this.copyInvite(view);
    else if (view.state === 'failed') void this.copyDetails();
    else if (view.state === 'empty') void this.issueInvite(false);
    else this.game.audio.playSe('ui-error');
  }

  private inviteLink(code: string): string {
    return inviteLinkOf(location.origin + location.pathname, code);
  }

  /** isAuto = 招待ができた時点で自動で試す (失敗しても知らせず、ENTER でコピーの案内を出したままにする) */
  private async copyInvite(view: HostSlotView, isAuto = false): Promise<void> {
    if (!view.code) return;
    const ok = await copyText(this.inviteLink(view.code), isAuto ? null : this.inviteBox);
    if (isAuto && !ok) return;
    if (ok) this.copiedSlots.add(view.slot);
    this.game.audio.playSe(ok ? 'ui-confirm' : 'ui-error');
    this.ui?.toast(
      ok ? `SLOT ${view.slot}: INVITE LINK COPIED. SEND IT TO ONE FRIEND.` : 'COULD NOT COPY. SELECT THE LINK IN THE BOX AND PRESS CTRL+C.',
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
    this.copiedSlots.delete(this.viewSlot);
    this.game.audio.playSe('ui-cancel');
    this.ui?.toast(`SLOT ${this.viewSlot}: CANCELLED. THE LINK CAN NO LONGER BE USED.`, colors.text);
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

  /** 今の招待の項目の名前 (コピー前はコピー、コピー後は次の招待) */
  private inviteLabel(lobby: HostLobby): string {
    if (this.isIssuing) return 'PREPARING INVITE...';
    const view = lobby.slot(this.viewSlot);
    return view?.state === 'inviting' && !this.copiedSlots.has(view.slot) ? 'COPY INVITE LINK' : labels.invite;
  }

  /** 画面の上に出す「いま何をすればよいか」(1 行、64 文字まで) */
  private hint(lobby: HostLobby): string {
    const view = lobby.slot(this.viewSlot);
    if (this.isIssuing || view?.state === 'preparing') return 'PREPARING AN INVITE LINK... (UP TO 5 SEC)';
    if (view?.state === 'inviting' && !this.copiedSlots.has(view.slot)) return 'PRESS ENTER (OR CLICK) TO COPY THE INVITE LINK';
    const slots = lobby.slots;
    if (slots.some((s) => s.state === 'connecting')) return 'CONNECTING TO A PLAYER... (UP TO 15 SEC)';
    if (slots.some((s) => s.state === 'inviting')) return 'SEND THE LINK TO A FRIEND, THEN PASTE THEIR REPLY HERE (CTRL+V)';
    const session = lobby.session;
    const others = session.players.filter((p) => p.id !== session.playerId);
    if (others.length > 0) {
      return others.every((p) => p.isReady) ? 'START THE RACE, OR MAKE A NEW INVITE FOR MORE PLAYERS' : 'WAITING FOR ALL PLAYERS TO BE READY';
    }
    return 'SELECT "NEW INVITE" TO INVITE A FRIEND';
  }

  private renderMenu(ctx: CanvasRenderingContext2D, ui: LobbyUi, lobby: HostLobby): void {
    const session = lobby.session;
    const others = session.players.filter((p) => p.id !== session.playerId);
    const canStart = lobby.status?.phase !== 'race' && others.every((p) => p.isReady);
    const team = teamOf(this.profile.team);
    const views: MenuItemView[] = items.map((item) => {
      switch (item) {
        case 'invite':
          return { label: this.inviteLabel(lobby), isEnabled: !this.isIssuing };
        case 'team':
          return { label: labels.team, isEnabled: true, value: `${team.carNumber} ${team.abbr}` };
        case 'laps':
          return { label: labels.laps, isEnabled: true, value: String(this.currentLaps(lobby)) };
        case 'slot':
          return { label: labels.slot, isEnabled: true, value: String(this.viewSlot) };
        case 'start':
          return { label: labels.start, isEnabled: canStart };
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
          row.status = 'PREPARING LINK...';
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
      const link = showCode && view.code ? this.inviteLink(view.code) : '';
      if (showCode && inviteBox.value !== link) inviteBox.value = link;
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
            'SELECT "NEW INVITE" TO MAKE AN INVITE LINK FOR THE NEXT OPEN SLOT. YOU CAN MAKE LINKS FOR SEVERAL PLAYERS AT ONCE.',
            'EACH PLAYER OPENS THEIR LINK AND SENDS A REPLY CODE BACK. PASTE THE REPLY CODES HERE WITH CTRL+V, IN ANY ORDER.',
          ],
          x, y + 28, w, { color: colors.text },
        );
        break;
      case 'preparing':
        drawText(ctx, `SLOT ${slot}: PREPARING THE INVITE LINK... (UP TO 5 SEC)`, x, y, { color: colors.white });
        break;
      case 'inviting': {
        const isCopied = this.copiedSlots.has(slot);
        const item = items[this.selected];
        if (isCopied) {
          ui.bigPrompt(ctx, promptRect, [`SLOT ${slot}: INVITE LINK COPIED`, 'SEND IT TO ONE FRIEND. CLICK HERE TO COPY AGAIN.'], colors.hudGreen, () => void this.copyInvite(view), 2);
        } else {
          const line1 = item === 'invite' || item === 'slot' ? 'PRESS ENTER (OR CLICK)' : 'CLICK HERE';
          ui.bigPrompt(ctx, promptRect, [line1, `TO COPY THE INVITE LINK (SLOT ${slot})`], colors.yellow, () => void this.copyInvite(view));
        }
        ui.button(ctx, { x: buttonX - buttonW - 10, y: codeY + 66, w: buttonW, h: 26 }, 'COPY', true, () => void this.copyInvite(view));
        ui.button(ctx, { x: buttonX, y: codeY + 66, w: buttonW, h: 26 }, 'CANCEL', true, () => this.cancelSlot());
        let ny = codeY + 106;
        ny += drawParagraph(ctx, netTexts.ipWarningLink, x, ny, w, { color: colors.subtext }) + 2;
        const gather = view.gather?.analysis;
        if (gather?.isStunUnreachable) drawParagraph(ctx, netTexts.stunUnreachable, x, ny, w, { color: colors.yellow, maxLines: 2 });
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
              ? ['COULD NOT MAKE AN INVITE LINK. TRY AGAIN.']
              : connectFailedLines(lobby.diagnosticsOf(slot)?.isSamePublicAddress === true);
        drawParagraph(ctx, lines, x, y + 24, w, { color: colors.text, maxLines: 7 });
        drawText(ctx, 'ON "SLOT": ENTER = DETAILS, DEL = CLEAR', x, codeY + codeH - 24, { color: colors.midGrey });
        break;
      }
    }
  }
}

/** 残り時間 m:ss */
function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
