import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { HostLobby } from '../host/HostLobby';
import type { HostSlotView } from '../host/HostLobby';
import type { HostRoomView } from '../host/HostRoom';
import type { NetProfile } from '../net/NetClientSession';
import type { NetRaceClient } from '../net/NetRaceClient';
import { netTimings } from '../net/netConfig';
import { inviteLinkOf } from '../shared/net/connectionCode';
import { copyText, readClipboardText } from '../ui/clipboard';
import { colors } from '../ui/colors';
import { drawLobbyList, lobbyListHeight, lobbyRowRect } from '../ui/lobbyList';
import type { LobbyRowView } from '../ui/lobbyList';
import type { MenuItemView } from '../ui/menuList';
import { acceptErrorText, connectFailedLines, hostRoomFailureText, netTexts, rejectText, slotFailureLabel } from '../ui/netTexts';
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

type HostItem = 'link' | 'start' | 'slot' | 'name' | 'team' | 'laps' | 'newLink' | 'codeInvite' | 'paste' | 'close';

/** よく使う順 (リンクのコピー → スタート)。予備の招待コード方式は下に置く。ホスト本人の準備完了は START RACE で自動で付ける */
const items: readonly HostItem[] = ['link', 'start', 'slot', 'name', 'team', 'laps', 'newLink', 'codeInvite', 'paste', 'close'];
const labels: Record<HostItem, string> = {
  link: 'COPY INVITE LINK',
  start: 'START RACE',
  slot: 'SLOT',
  name: 'NAME',
  team: 'TEAM',
  laps: 'LAPS',
  newLink: 'NEW LINK',
  codeInvite: 'CODE INVITE (BACKUP)',
  paste: 'PASTE REPLY',
  close: 'CLOSE LOBBY',
};
/** この項目を選んでいる間は、下の欄に枠 (招待コード・参加者) の詳細を出す。ほかは共通リンクを出す */
const slotPanelItems: readonly HostItem[] = ['slot', 'codeInvite', 'paste'];

const menuX = 12;
const menuY = 56;
const menuW = 320;
const menuRowH = 24;
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
/** 2 回押してもらう操作 (ロビーを閉じる・KICK・NEW LINK) を確かめる時間 (秒) */
const confirmTime = 3;
/** START を押してから、ホスト本人の準備完了が届くのを待つ時間 (秒) */
const startWaitTime = 2;

/**
 * ロビー (ホスト、network.md「ホストの画面」「中継による接続」)。ロビーを作った直後に中継に部屋を作り、全員共通の招待リンク
 * (#room=) ができたら自動でコピーを試す (できなければ「ENTER でコピー」の大きな案内)。参加者はリンクを開くだけで空き枠に入る。
 * 中継が使えなければ、従来の 1 人用の招待リンク + 返答コード (どこでも Ctrl+V) に自動で切り替える。従来の方式は予備として
 * CODE INVITE でいつでも使える。参加者一覧 8 枠、KICK・NEW LINK (2 回押し)、[詳細をコピー]、周回数、スタート。
 * 招待リンク・貼り付け・名前は Canvas に重ねた DOM で扱う。lobby を渡すとそのロビーに戻る (リザルトから)。null なら新しく作る。
 */
export class HostLobbyScene implements Scene {
  private lobby: HostLobby | null;
  private ui: LobbyUi | null = null;
  /** 下の欄に出すリンク (共通リンク・1 人用の招待リンク) の読み取り専用欄 */
  private linkBox: HTMLTextAreaElement | null = null;
  private profile: NetProfile;
  private selected = 0;
  /** 枠の欄に出している枠 (1〜7) */
  private viewSlot = 1;
  private loadingUpdates = 0;
  private closeConfirmRemaining = 0;
  private newLinkConfirmRemaining = 0;
  private kickConfirm: { slot: number; remaining: number } | null = null;
  private startWaitRemaining = 0;
  private isAwaitingJoin = false;
  private isCheckingCode = false;
  /** 招待コードを作っている (発行はユーザー操作のあと最大 5 秒かかる) */
  private isIssuing = false;
  /** 今の招待リンクをコピーした枠 (新しく発行したら外す) */
  private readonly copiedSlots = new Set<number>();
  /** 枠ごとの前回の状態 (参加・失敗・退出の知らせを出すため)。枠 1〜7 → 状態と参加者名 */
  private readonly lastSlotStates = new Map<number, string>();
  /** KICK した枠 (「抜けた」の知らせの代わりに KICK の知らせを出したので、重ねて出さない) */
  private readonly kickedSlots = new Set<number>();
  /** コピーした共通リンク・自動でコピーを試した共通リンク */
  private copiedRoomLink: string | null = null;
  private autoCopiedRoomLink: string | null = null;
  /** 中継の部屋の前回の状態 (切り替わりの知らせを出すため) */
  private lastRoomKey = 'none';

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
    this.ui?.toast('YOU ARE HOSTING, SO YOU CANNOT JOIN ANOTHER LOBBY HERE. SEND THE INVITE LINK TO YOUR FRIENDS.');
  };

  enter(): void {
    this.game.audio.playBgm('menu-theme');
    setInviteHandler(this.onInvite);
    this.ui = new LobbyUi(this.game, {
      onPaste: (text) => void this.acceptReply(text),
      onNameCommit: (name) => this.commitName(name),
      nameRect: { x: menuX + 170, y: menuY + items.indexOf('name') * menuRowH, w: 150, h: 20 },
    });
    this.ui.showName(this.profile.name);
    this.linkBox = this.ui.overlay.addCodeBox('invite-code', { x: codeX + 10, y: codeY + 66, w: buttonX - buttonW - codeX - 30, h: 32 });
    this.ui.overlay.addPasteBox(
      'paste-input',
      { x: menuX + 190, y: menuY + items.indexOf('paste') * menuRowH, w: 130, h: 20 },
      'CTRL+V',
      (text) => void this.acceptReply(text),
    );
    this.ui.overlay.setVisible(this.linkBox, false);
    if (this.lobby) {
      // リザルトから戻った: 共通リンクはもう送ってあるので、自動でコピーし直さない
      const link = this.lobby.room?.link ?? null;
      this.copiedRoomLink = link;
      this.autoCopiedRoomLink = link;
      this.attach(this.lobby);
    }
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
    this.newLinkConfirmRemaining = Math.max(0, this.newLinkConfirmRemaining - dt);
    if (this.kickConfirm) {
      this.kickConfirm.remaining -= dt;
      if (this.kickConfirm.remaining <= 0) this.kickConfirm = null;
    }
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
    if (this.isRelayDown(lobby)) drawText(ctx, netTexts.relayUnavailable, width - 12, 12, { color: colors.yellow, align: 'right' });
    else drawText(ctx, 'CTRL+V ANYWHERE: PASTE A REPLY CODE', width - 12, 12, { color: colors.subtext, align: 'right' });
    ui.drawHint(ctx, this.hint(lobby));

    this.renderMenu(ctx, ui, lobby);
    this.renderList(ctx, ui, lobby);
    if (this.isRoomPanelShown(lobby)) this.renderRoomPanel(ctx, ui, lobby);
    else this.renderSlotPanel(ctx, ui, lobby);
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
    // 共通リンクはすぐ作り始める (ロビーを作る = 誰かを招待する、なので)。中継が使えなければ招待コードに切り替わる
    this.openRoom(lobby);
  }

  private attach(lobby: HostLobby): void {
    // 今の枠・部屋の状態を覚えておく (ここからの変化だけを知らせる)
    this.noticeSlotChanges(lobby);
    this.lastRoomKey = roomKeyOf(lobby.room);
    lobby.onChange = () => this.onLobbyChange();
    lobby.session.onChange = () => this.onLobbyChange();
    lobby.session.onRaceStart = (race) => this.onRaceStart(lobby, race);
  }

  /** 招待リンクの元にするページの URL。開発時は中継の指定 (?signal=) を参加者にも引き継ぐ */
  private pageUrl(): string {
    const base = location.origin + location.pathname;
    if (!import.meta.env.DEV) return base;
    const signal = new URLSearchParams(location.search).get('signal');
    return signal ? `${base}?signal=${encodeURIComponent(signal)}` : base;
  }

  private openRoom(lobby: HostLobby): void {
    lobby.openRoom(this.pageUrl());
  }

  private onLobbyChange(): void {
    const lobby = this.lobby;
    if (!lobby) return;
    const session = lobby.session;
    this.noticeSlotChanges(lobby);
    this.noticeRoomChanges(lobby);
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

  /** 中継の部屋の状態が変わった: リンクができたら自動でコピーを試し、使えなくなったら知らせて招待コードに切り替える */
  private noticeRoomChanges(lobby: HostLobby): void {
    const room = lobby.room;
    const key = roomKeyOf(room);
    if (key === this.lastRoomKey) return;
    this.lastRoomKey = key;
    if (!room) return;
    if (room.state === 'open' && room.link && this.autoCopiedRoomLink !== room.link) {
      this.autoCopiedRoomLink = room.link;
      if (!this.ui?.isEditingName) this.selected = items.indexOf('link');
      void this.copyRoomLink(true);
    } else if (room.state === 'unavailable') {
      this.game.audio.playSe('ui-error');
      this.ui?.toast(hostRoomFailureText(room.failure));
      // 中継そのものが使えないときは、従来の 1 人用の招待リンクを作る (期限切れ・別のタブは NEW LINK で作り直せる)
      if (this.isRelayDown(lobby) && !this.isIssuing && !this.hasPendingInvite(lobby)) void this.issueInvite(true);
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
      } else if (view.state === 'empty' && this.kickedSlots.delete(slot)) {
        // KICK の知らせはもう出した
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

  // ---- 中継の状態 ----

  /** 共通リンクが使える・作っている途中 */
  private isRoomUsable(lobby: HostLobby): boolean {
    const state = lobby.room?.state;
    return state === 'open' || state === 'connecting';
  }

  /** 中継そのものが使えず、招待コードの方式に切り替えた (期限切れ・別のタブは NEW LINK で作り直せるので含めない) */
  private isRelayDown(lobby: HostLobby): boolean {
    const room = lobby.room;
    if (!room) return true;
    return room.state === 'unavailable' && room.failure !== 'expired' && room.failure !== 'replaced';
  }

  /** 下の欄に共通リンクを出すか (出さないときは枠の詳細) */
  private isRoomPanelShown(lobby: HostLobby): boolean {
    return !this.isRelayDown(lobby) && !slotPanelItems.includes(items[this.selected]);
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
        this.kickConfirm = null;
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
      case 'link':
        this.linkAction(lobby);
        break;
      case 'newLink':
        this.requestNewLink(lobby);
        break;
      case 'codeInvite':
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

  /** 先頭の項目: 共通リンクをコピー。中継が使えないときは招待コード、期限切れなどは作り直し */
  private linkAction(lobby: HostLobby): void {
    const room = lobby.room;
    if (this.isRelayDown(lobby)) {
      this.inviteAction();
    } else if (room?.state === 'unavailable') {
      this.requestNewLink(lobby);
    } else if (room?.link) {
      void this.copyRoomLink();
    } else {
      this.game.audio.playSe('ui-error');
      this.ui?.toast('MAKING THE INVITE LINK. WAIT A MOMENT.', colors.text);
    }
  }

  /** isAuto = リンクができた時点で自動で試す (失敗しても知らせず、ENTER でコピーの案内を出したままにする) */
  private async copyRoomLink(isAuto = false): Promise<void> {
    const link = this.lobby?.room?.link;
    if (!link) return;
    const ok = await copyText(link, isAuto ? null : this.linkBox);
    if (isAuto && !ok) return;
    if (ok) this.copiedRoomLink = link;
    this.game.audio.playSe(ok ? 'ui-confirm' : 'ui-error');
    this.ui?.toast(
      ok ? 'INVITE LINK COPIED. PASTE IT IN YOUR GROUP CHAT OR SEND IT TO YOUR FRIENDS.' : 'COULD NOT COPY. SELECT THE LINK IN THE BOX AND PRESS CTRL+C.',
      ok ? colors.hudGreen : colors.yellow,
    );
  }

  /**
   * 共通リンクを作り直す (前のリンクでは入れなくなる。ロビーにいる人はそのまま)。
   * 使えるリンクがあるときは 2 回押してもらう (送ったリンクを誤って無効にしないように)
   */
  private requestNewLink(lobby: HostLobby): void {
    const audio = this.game.audio;
    if (lobby.room?.state === 'open' && this.newLinkConfirmRemaining <= 0) {
      this.newLinkConfirmRemaining = confirmTime;
      audio.playSe('ui-error');
      this.ui?.toast('PRESS AGAIN TO MAKE A NEW LINK. THE CURRENT LINK WILL STOP WORKING (PLAYERS IN THE LOBBY STAY).');
      return;
    }
    this.newLinkConfirmRemaining = 0;
    audio.playSe('ui-confirm');
    const hadLink = lobby.room?.link != null;
    this.openRoom(lobby);
    this.selected = items.indexOf('link');
    this.ui?.toast(hadLink ? 'MAKING A NEW LINK. THE OLD LINK NO LONGER WORKS.' : 'MAKING A NEW INVITE LINK...', colors.text);
  }

  /** CODE INVITE で決定: 今の招待をまだコピーしていなければコピー、コピー済みなら次の招待を作る */
  private inviteAction(): void {
    const view = this.lobby?.slot(this.viewSlot);
    if (view?.state === 'inviting' && !this.copiedSlots.has(view.slot)) {
      void this.copyInvite(view);
      return;
    }
    if (this.isIssuing) {
      this.game.audio.playSe('ui-error');
      this.ui?.toast('PREPARING THE INVITE CODE. WAIT A MOMENT.', colors.text);
      return;
    }
    void this.issueInvite(false);
  }

  /** isAuto = 中継が使えないと分かった直後の自動の発行 */
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
    if (!this.ui?.isEditingName) this.selected = items.indexOf('codeInvite');
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
    if (!this.ui.isEditingName) this.selected = items.indexOf('codeInvite');
    // コピーできる環境 (ページにフォーカスがあるなど) なら自動でコピーする。できなければ「ENTER でコピー」の案内のまま
    await this.copyInvite(view, true);
  }

  /** 枠の欄で決定: 招待中ならリンクをコピー、失敗なら詳細をコピー、参加者なら KICK、空きなら招待 */
  private slotAction(): void {
    const lobby = this.lobby;
    const view = lobby?.slot(this.viewSlot);
    if (!lobby || !view) return;
    if (view.state === 'inviting') void this.copyInvite(view);
    else if (view.state === 'failed') void this.copyDetails();
    else if (view.state === 'joined') this.requestKick(view.slot);
    else if (view.state === 'empty' && this.isRoomUsable(lobby)) void this.copyRoomLink();
    else if (view.state === 'empty') void this.issueInvite(false);
    else this.game.audio.playSe('ui-error');
  }

  /** 参加者を外す (2 回押し)。外された人も共通リンクを持っていれば入り直せる */
  private requestKick(slot: number): void {
    const lobby = this.lobby;
    if (!lobby) return;
    const name = lobby.session.players.find((p) => p.id === slot)?.name ?? `SLOT ${slot}`;
    if (this.kickConfirm?.slot !== slot) {
      this.kickConfirm = { slot, remaining: confirmTime };
      this.game.audio.playSe('ui-error');
      this.ui?.toast(`PRESS KICK AGAIN TO REMOVE ${name} FROM THE LOBBY.`);
      return;
    }
    this.kickConfirm = null;
    if (!lobby.kick(slot)) {
      this.game.audio.playSe('ui-error');
      return;
    }
    this.kickedSlots.add(slot);
    this.game.audio.playSe('ui-cancel');
    this.ui?.toast(`SLOT ${slot}: ${name} WAS REMOVED. THEY CAN REJOIN WITH THE SAME LINK. TO KEEP THEM OUT, USE "NEW LINK".`, colors.text);
  }

  private codeInviteLink(code: string): string {
    return inviteLinkOf(location.origin + location.pathname, code);
  }

  /** isAuto = 招待ができた時点で自動で試す (失敗しても知らせず、ENTER でコピーの案内を出したままにする) */
  private async copyInvite(view: HostSlotView, isAuto = false): Promise<void> {
    if (!view.code) return;
    const ok = await copyText(this.codeInviteLink(view.code), isAuto ? null : this.linkBox);
    if (isAuto && !ok) return;
    if (ok) this.copiedSlots.add(view.slot);
    this.game.audio.playSe(ok ? 'ui-confirm' : 'ui-error');
    this.ui?.toast(
      ok ? `SLOT ${view.slot}: CODE INVITE LINK COPIED. SEND IT TO ONE FRIEND.` : 'COULD NOT COPY. SELECT THE LINK IN THE BOX AND PRESS CTRL+C.',
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

  /** DEL: 招待中・失敗の枠を空ける。参加者なら KICK */
  private cancelSlot(): void {
    const lobby = this.lobby;
    const view = lobby?.slot(this.viewSlot);
    if (!lobby || !view) return;
    if (view.state === 'joined') {
      this.requestKick(view.slot);
      return;
    }
    if (view.state === 'empty' || view.state === 'connecting') {
      this.game.audio.playSe('ui-error');
      return;
    }
    lobby.cancelInvite(this.viewSlot);
    this.copiedSlots.delete(this.viewSlot);
    this.game.audio.playSe('ui-cancel');
    this.ui?.toast(`SLOT ${this.viewSlot}: CANCELLED. THE CODE INVITE CAN NO LONGER BE USED.`, colors.text);
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
      this.closeConfirmRemaining = confirmTime;
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

  /** 招待コードの項目の名前 (コピー前はコピー、コピー後は次の招待) */
  private inviteLabel(lobby: HostLobby): string {
    if (this.isIssuing) return 'PREPARING CODE...';
    const view = lobby.slot(this.viewSlot);
    return view?.state === 'inviting' && !this.copiedSlots.has(view.slot) ? 'COPY CODE INVITE' : labels.codeInvite;
  }

  /** 先頭の項目の名前 */
  private linkLabel(lobby: HostLobby): string {
    const room = lobby.room;
    if (this.isRelayDown(lobby)) return this.inviteLabel(lobby) === labels.codeInvite ? 'NEW INVITE' : this.inviteLabel(lobby);
    if (room?.state === 'unavailable') return 'NEW LINK';
    if (!room?.link) return 'MAKING LINK...';
    return labels.link;
  }

  /** 画面の上に出す「いま何をすればよいか」(1 行、64 文字まで) */
  private hint(lobby: HostLobby): string {
    const session = lobby.session;
    const others = session.players.filter((p) => p.id !== session.playerId);
    const slots = lobby.slots;
    if (this.isRoomPanelShown(lobby)) {
      const room = lobby.room;
      if (room?.state === 'unavailable') return 'THE LINK EXPIRED. SELECT "NEW LINK" TO MAKE A NEW ONE';
      if (!room?.link) return 'MAKING THE INVITE LINK... (A FEW SECONDS)';
      if (this.copiedRoomLink !== room.link) return 'PRESS ENTER (OR CLICK) TO COPY THE INVITE LINK';
      if (slots.some((s) => s.state === 'connecting')) return 'A PLAYER IS CONNECTING...';
      if (others.length > 0) {
        return others.every((p) => p.isReady) ? 'START THE RACE, OR SEND THE LINK TO MORE FRIENDS' : 'WAITING FOR ALL PLAYERS TO BE READY';
      }
      return 'SEND THIS LINK TO YOUR FRIENDS (GROUP CHAT OK)';
    }
    const view = lobby.slot(this.viewSlot);
    if (this.isIssuing || view?.state === 'preparing') return 'PREPARING AN INVITE CODE... (UP TO 5 SEC)';
    if (view?.state === 'inviting' && !this.copiedSlots.has(view.slot)) return 'PRESS ENTER (OR CLICK) TO COPY THE CODE INVITE LINK';
    if (slots.some((s) => s.state === 'connecting')) return 'CONNECTING TO A PLAYER...';
    if (slots.some((s) => s.state === 'inviting')) return 'SEND THE LINK TO A FRIEND, THEN PASTE THEIR REPLY HERE (CTRL+V)';
    if (others.length > 0) {
      return others.every((p) => p.isReady) ? 'START THE RACE, OR INVITE MORE PLAYERS' : 'WAITING FOR ALL PLAYERS TO BE READY';
    }
    return this.isRelayDown(lobby) ? 'SELECT "NEW INVITE" TO INVITE A FRIEND' : 'SELECT "CODE INVITE" IF THE LINK DOES NOT WORK FOR SOMEONE';
  }

  private renderMenu(ctx: CanvasRenderingContext2D, ui: LobbyUi, lobby: HostLobby): void {
    const session = lobby.session;
    const others = session.players.filter((p) => p.id !== session.playerId);
    const canStart = lobby.status?.phase !== 'race' && others.every((p) => p.isReady);
    const team = teamOf(this.profile.team);
    const room = lobby.room;
    const views: MenuItemView[] = items.map((item) => {
      switch (item) {
        case 'link':
          return { label: this.linkLabel(lobby), isEnabled: this.isRelayDown(lobby) ? !this.isIssuing : room?.link != null || room?.state === 'unavailable' };
        case 'newLink':
          return { label: this.newLinkConfirmRemaining > 0 ? 'NEW LINK? PRESS AGAIN' : labels.newLink, isEnabled: room?.state !== 'connecting' || room.link !== null };
        case 'codeInvite':
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
          row.status = 'PREPARING CODE...';
          row.statusColor = colors.text;
          break;
        case 'inviting':
          row.status = `CODE SENT  ${formatRemaining(s.remainingMs ?? 0)}`;
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
        if (this.viewSlot !== slot) this.kickConfirm = null;
        this.viewSlot = slot;
        this.selected = items.indexOf('slot');
        this.game.audio.playSe('ui-cursor');
      });
    }
    const y = listY + lobbyListHeight(rows.length) + 2;
    drawText(ctx, `COURSE 1   LAPS ${this.currentLaps(lobby)}`, listX + 8, y, { color: colors.subtext });
  }

  /** 読み取り専用のリンク欄に link を出す (null なら隠す) */
  private showLinkBox(ui: LobbyUi, link: string | null): void {
    const box = this.linkBox;
    if (!box) return;
    ui.overlay.setVisible(box, link !== null);
    if (link !== null && box.value !== link) box.value = link;
  }

  /** 下の欄: 全員共通の招待リンク (中継) */
  private renderRoomPanel(ctx: CanvasRenderingContext2D, ui: LobbyUi, lobby: HostLobby): void {
    drawPanel(ctx, codeX, codeY, codeW, codeH);
    const room = lobby.room;
    const x = codeX + 10;
    const y = codeY + 8;
    const w = codeW - 20;
    const link = room?.link ?? null;
    this.showLinkBox(ui, link);
    const newLinkRect = { x: buttonX, y: codeY + 66, w: buttonW, h: 26 };
    if (room?.state === 'unavailable') {
      drawText(ctx, 'THE INVITE LINK CAN NO LONGER BE USED', x, y, { color: colors.red });
      drawParagraph(ctx, [hostRoomFailureText(room.failure), 'PLAYERS ALREADY IN THE LOBBY STAY.'], x, y + 28, w, { color: colors.text });
      ui.button(ctx, newLinkRect, labels.newLink, true, () => this.requestNewLink(lobby));
      return;
    }
    if (!link) {
      drawText(ctx, 'MAKING THE INVITE LINK... (A FEW SECONDS)', x, y, { color: colors.white });
      drawParagraph(ctx, 'EVERYONE USES THE SAME LINK. SEND IT ONCE, E.G. TO YOUR GROUP CHAT.', x, y + 28, w, { color: colors.text });
      return;
    }
    const isCopied = this.copiedRoomLink === link;
    const item = items[this.selected];
    if (isCopied) {
      ui.bigPrompt(ctx, promptRect, ['INVITE LINK COPIED', 'PASTE IT IN YOUR GROUP CHAT. CLICK HERE TO COPY AGAIN.'], colors.hudGreen, () => void this.copyRoomLink(), 2);
    } else {
      const line1 = item === 'link' ? 'PRESS ENTER (OR CLICK)' : 'CLICK HERE';
      ui.bigPrompt(ctx, promptRect, [line1, 'TO COPY THE INVITE LINK'], colors.yellow, () => void this.copyRoomLink());
    }
    ui.button(ctx, { x: buttonX - buttonW - 10, y: codeY + 66, w: buttonW, h: 26 }, 'COPY', true, () => void this.copyRoomLink());
    const newLabel = this.newLinkConfirmRemaining > 0 ? 'AGAIN = NEW' : labels.newLink;
    ui.button(ctx, newLinkRect, newLabel, true, () => {
      this.selected = items.indexOf('newLink');
      this.requestNewLink(lobby);
    });
    let ny = codeY + 106;
    const status =
      room?.state === 'open'
        ? `ONE LINK FOR EVERYONE (UP TO 8 PLAYERS). EXPIRES IN ${formatRemaining(room.remainingMs ?? 0)}.`
        : 'RECONNECTING TO THE RELAY... THE LINK STAYS THE SAME.';
    ny += drawParagraph(ctx, status, x, ny, w, { color: room?.state === 'open' ? colors.cyan : colors.yellow }) + 2;
    drawParagraph(ctx, netTexts.roomLinkWarning, x, ny, w, { color: colors.subtext, maxLines: 3 });
  }

  /** 下の欄: 選んでいる枠 (招待コード・参加者) の詳細 */
  private renderSlotPanel(ctx: CanvasRenderingContext2D, ui: LobbyUi, lobby: HostLobby): void {
    drawPanel(ctx, codeX, codeY, codeW, codeH);
    const view = lobby.slot(this.viewSlot);
    const showCode = view?.state === 'inviting' && view.code !== null;
    this.showLinkBox(ui, showCode && view.code ? this.codeInviteLink(view.code) : null);
    if (!view) return;
    const x = codeX + 10;
    const y = codeY + 8;
    const w = codeW - 20;
    const slot = view.slot;
    const player = lobby.session.players.find((p) => p.id === slot);
    const isRelayDown = this.isRelayDown(lobby);
    switch (view.state) {
      case 'empty':
        drawText(ctx, `SLOT ${slot}: OPEN`, x, y, { color: colors.white });
        drawParagraph(
          ctx,
          isRelayDown
            ? [
                netTexts.relayUnavailable,
                'SELECT "NEW INVITE" TO MAKE AN INVITE LINK FOR THE NEXT OPEN SLOT (ONE LINK PER PLAYER). YOU CAN MAKE LINKS FOR SEVERAL PLAYERS AT ONCE.',
                'EACH PLAYER OPENS THEIR LINK AND SENDS A REPLY CODE BACK. PASTE THE REPLY CODES HERE WITH CTRL+V, IN ANY ORDER.',
              ]
            : [
                'PLAYERS WHO OPEN THE INVITE LINK FILL THE OPEN SLOTS AUTOMATICALLY.',
                'IF THE LINK DOES NOT WORK FOR SOMEONE, SELECT "CODE INVITE": A LINK FOR ONE PLAYER, WHO THEN SENDS BACK A REPLY CODE. PASTE IT HERE WITH CTRL+V.',
              ],
          x, y + 28, w, { color: colors.text },
        );
        break;
      case 'preparing':
        drawText(ctx, `SLOT ${slot}: PREPARING THE INVITE CODE... (UP TO 5 SEC)`, x, y, { color: colors.white });
        break;
      case 'inviting': {
        const isCopied = this.copiedSlots.has(slot);
        const item = items[this.selected];
        if (isCopied) {
          ui.bigPrompt(ctx, promptRect, [`SLOT ${slot}: CODE INVITE LINK COPIED`, 'SEND IT TO ONE FRIEND. CLICK HERE TO COPY AGAIN.'], colors.hudGreen, () => void this.copyInvite(view), 2);
        } else {
          const line1 = item === 'codeInvite' || item === 'slot' || (item === 'link' && isRelayDown) ? 'PRESS ENTER (OR CLICK)' : 'CLICK HERE';
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
      case 'connecting': {
        const limit = (view.via === 'room' ? netTimings.relayLinkTimeoutMs : netTimings.connectTimeoutMs) / 1000;
        drawText(ctx, `SLOT ${slot}: CONNECTING... (UP TO ${limit} SEC)`, x, y, { color: colors.white });
        break;
      }
      case 'joined': {
        drawText(ctx, player ? `SLOT ${slot}: ${player.name} JOINED` : `SLOT ${slot}: CONNECTED. WAITING FOR THE PLAYER TO JOIN...`, x, y, {
          color: colors.white,
        });
        const isConfirming = this.kickConfirm?.slot === slot;
        ui.button(ctx, { x: buttonX, y: codeY + codeH - 34, w: buttonW, h: 26 }, isConfirming ? 'KICK: AGAIN' : 'KICK', true, () => {
          this.selected = items.indexOf('slot');
          this.requestKick(slot);
        });
        drawParagraph(
          ctx,
          'KICK REMOVES THE PLAYER FROM THE LOBBY. THEY CAN REJOIN WITH THE SAME INVITE LINK, SO USE "NEW LINK" TO KEEP THEM OUT.',
          x, y + 28, w, { color: colors.text },
        );
        drawText(ctx, 'ON "SLOT": ENTER OR DEL = KICK (PRESS TWICE)', x, codeY + codeH - 24, { color: colors.midGrey });
        break;
      }
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
        drawText(ctx, 'ON "SLOT": ENTER = DETAILS, DEL = CLEAR', x, codeY + codeH - 24, { color: colors.midGrey });
        break;
      }
    }
  }
}

/** 部屋の状態の切り替わりを見分けるための値 (残り時間は含めない) */
function roomKeyOf(room: HostRoomView | null): string {
  return room ? `${room.state}:${room.failure ?? ''}:${room.link ?? ''}` : 'none';
}

/** 残り時間 m:ss */
function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
