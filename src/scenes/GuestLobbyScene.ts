import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { GuestConnector } from '../net/GuestConnector';
import { NetClientSession } from '../net/NetClientSession';
import type { NetProfile } from '../net/NetClientSession';
import type { NetRaceClient } from '../net/NetRaceClient';
import { netTimings } from '../net/netConfig';
import type { LinkDiagnostics } from '../net/PeerLink';
import { checkConnectionCode, extractConnectionCode } from '../shared/net/connectionCode';
import { copyText, readClipboardText } from '../ui/clipboard';
import { colors } from '../ui/colors';
import { drawLobbyList } from '../ui/lobbyList';
import type { LobbyRowView } from '../ui/lobbyList';
import type { MenuItemView } from '../ui/menuList';
import { closeText, codeErrorText, guestFailureLines, netTexts, rejectText } from '../ui/netTexts';
import { drawPanel } from '../ui/panel';
import { drawParagraph } from '../ui/paragraph';
import { teamOf } from '../ui/teams';
import { drawText } from '../ui/text';
import { getCourseTrack } from './courseCache';
import { LobbyUi } from './LobbyUi';
import { alternativeName, nextFreeTeam } from './lobbyRules';
import { MenuScene } from './MenuScene';
import { moveMenuCursor, wasMenuBackPressed, wasMenuConfirmPressed, wasMenuDownPressed, wasMenuLeftPressed, wasMenuRightPressed, wasMenuUpPressed } from './menuKeys';
import { MultiplayerScene } from './MultiplayerScene';
import { NetRaceScene } from './NetRaceScene';
import { loadNetProfile, saveNetProfile } from './netProfile';

/**
 * paste = 招待リンク・コードを待っている、preparing = 返答コードを作っている (最大 5 秒)、waiting = 返答コードを出してホストを待っている、
 * joining = つながって join の返事を待っている、lobby = ロビーにいる、rejected = 名前・チームの重複などで断られた、
 * failed = つながらなかった、closed = ホストとの接続が切れた
 */
type GuestPhase = 'paste' | 'preparing' | 'waiting' | 'joining' | 'lobby' | 'rejected' | 'failed' | 'closed';

type GuestItem = 'name' | 'team' | 'pasteInvite' | 'copyReply' | 'ready' | 'joinAgain' | 'copyDetails' | 'retry' | 'leave' | 'back' | 'ok';

const labels: Record<GuestItem, string> = {
  name: 'NAME',
  team: 'TEAM',
  pasteInvite: 'PASTE INVITE',
  copyReply: 'COPY REPLY CODE',
  ready: 'READY',
  joinAgain: 'JOIN AGAIN',
  copyDetails: 'COPY DETAILS',
  retry: 'START OVER',
  leave: 'LEAVE LOBBY',
  back: 'BACK',
  ok: 'OK',
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
const promptRect = { x: codeX + 10, y: codeY + 8, w: codeW - 20, h: 56 };
/** 名前・チームの重複で断られたとき、自動で変えて入り直す回数の上限 */
const maxAutoJoinAttempts = 16;

/**
 * ロビー (参加者、network.md「参加者の画面」)。招待リンクで開く (invite に招待コード) か、招待リンク・コードを貼り付ける
 * (どこでも Ctrl+V・ボタン・貼り付け欄) → 返答コードができたら自動でコピーを試し、できなければ「ENTER でコピー」の大きな案内
 * → 「ホストの操作を待っています」→ 接続後は参加者一覧。ロビーに入った時点で準備完了にする (外すこともできる)。
 * 名前・チームは前回の値で入り、重複で断られたら自動で名前に数字を付ける・次のチームに変えて入り直す。
 * session を渡すとそのロビーに戻る (リザルトから)。
 */
export class GuestLobbyScene implements Scene {
  private session: NetClientSession | null;
  private connector: GuestConnector | null = null;
  private ui: LobbyUi | null = null;
  private replyBox: HTMLTextAreaElement | null = null;
  private pasteBox: HTMLTextAreaElement | null = null;
  private profile: NetProfile;
  private localPhase: 'paste' | 'preparing' | 'waiting' | 'failed' = 'paste';
  private failureLines: readonly string[] = [];
  private failureDiagnostics: LinkDiagnostics | null = null;
  private selected = 0;
  /** つながってから welcome を待った時間 (秒)。5 秒で「応答がありません」 */
  private joiningTime = 0;
  private isAwaitingJoin = false;
  private isCheckingCode = false;
  private isReplyCopied = false;
  /** 重複で断られて自動で入り直した回数と、名前に数字を付けるときの元の名前 */
  private autoJoinAttempts = 0;
  private autoNameAttempts = 0;
  private autoNameBase = '';
  /** 自動で変えた名前・チームで入った (保存しない。本人が変えたときだけ保存する) */
  private isAutoAdjusted = false;
  /** 準備完了にしたいか (ロビーに入った時点で true)。送って反映を待っている間は isReadySent */
  private wantsReady = true;
  private isReadySent = false;

  constructor(
    private readonly game: Game,
    session: NetClientSession | null,
    private readonly initialInvite: string | null = null,
  ) {
    this.session = session;
    this.profile = session ? { ...session.profile } : loadNetProfile();
  }

  private get phase(): GuestPhase {
    const s = this.session;
    if (!s) return this.localPhase;
    if (this.localPhase === 'failed') return 'failed';
    switch (s.state) {
      case 'joining':
        return 'joining';
      case 'lobby':
      case 'race':
        return 'lobby';
      case 'rejected':
        return 'rejected';
      case 'closed':
        return 'closed';
    }
  }

  /** 名前はどの段階でもメニューの 2 行目 (入力欄の位置を固定するため) */
  private get items(): readonly GuestItem[] {
    switch (this.phase) {
      case 'paste':
        return ['pasteInvite', 'name', 'team', 'back'];
      case 'preparing':
        return ['back'];
      case 'waiting':
        return ['copyReply', 'name', 'team', 'retry', 'back'];
      case 'joining':
        return ['back'];
      case 'lobby':
        return ['ready', 'name', 'team', 'leave'];
      case 'rejected':
        return ['joinAgain', 'name', 'team', 'leave'];
      case 'failed':
        return ['copyDetails', 'retry', 'back'];
      case 'closed':
        return ['ok'];
    }
  }

  enter(): void {
    this.game.audio.playBgm('menu-theme');
    this.ui = new LobbyUi(this.game, {
      onPaste: (text) => void this.acceptInvite(text),
      onNameCommit: (name) => this.commitName(name),
      nameRect: { x: menuX + 170, y: menuY + menuRowH + 1, w: 150, h: 22 },
    });
    this.ui.showName(this.profile.name);
    this.replyBox = this.ui.overlay.addCodeBox('reply-code', { x: codeX + 10, y: codeY + 70, w: buttonX - codeX - 20, h: 36 });
    this.pasteBox = this.ui.overlay.addPasteBox(
      'paste-input',
      { x: codeX + 10, y: codeY + 100, w: codeW - 20, h: 48 },
      'PASTE THE INVITE LINK OR CODE HERE (CTRL+V)',
      (text) => void this.acceptInvite(text),
    );
    // 走り始める前にコースを作っておく (つながってからの join で使う。約 0.5 秒)
    getCourseTrack();
    if (this.session) {
      this.attach(this.session);
      this.selected = this.items.indexOf('ready');
      this.syncReady(this.session);
    } else if (this.initialInvite) {
      void this.acceptInvite(this.initialInvite);
    }
    this.game.resetClock();
  }

  exit(): void {
    this.ui?.destroy();
    this.ui = null;
    if (this.session) this.session.onChange = null;
  }

  update(dt: number): void {
    const ui = this.ui;
    if (!ui) return;
    ui.update(dt);
    const phase = this.phase;
    if (phase === 'joining') {
      this.joiningTime += dt;
      if (this.joiningTime * 1000 > netTimings.handshakeTimeoutMs) this.fail(null, [netTexts.noResponse]);
    }
    const items = this.items;
    if (this.selected >= items.length) this.selected = 0;
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
      this.confirm(items.includes('leave') ? 'leave' : items.includes('ok') ? 'ok' : 'back');
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, width, height);
    const ui = this.ui;
    if (!ui) return;
    ui.beginRender();
    const phase = this.phase;
    drawText(ctx, 'JOIN LOBBY', 12, 6, { scale: 3, color: colors.white });
    const isTrouble = phase === 'rejected' || phase === 'failed' || phase === 'closed';
    ui.drawHint(ctx, this.hint(phase), isTrouble ? colors.red : colors.yellow);

    const items = this.items;
    ui.overlay.setVisible(ui.nameInput, items.includes('name'));
    this.renderMenu(ctx, ui, items);
    if (phase === 'lobby' && this.session) this.renderList(ctx, this.session);
    else this.renderSteps(ctx, phase);
    this.renderCodePanel(ctx, ui, phase);
    ui.drawToast(ctx, 12, 520, 776, 3);
  }

  // ---- 接続 ----

  private async acceptInvite(text: string): Promise<void> {
    if (this.phase !== 'paste' || this.isCheckingCode) {
      if (this.phase !== 'paste') this.ui?.toast('YOU ALREADY USED AN INVITE. SELECT "START OVER" TO USE ANOTHER ONE.', colors.text);
      return;
    }
    // 招待リンクでもコードだけでも受け付ける。貼り付けた瞬間に形式・種類・バージョンを確かめる
    const code = extractConnectionCode(text) ?? text;
    const check = checkConnectionCode(code, 'invite');
    if (!check.ok) {
      this.game.audio.playSe('ui-error');
      this.ui?.toast(codeErrorText(check.error, 'invite'));
      return;
    }
    this.isCheckingCode = true;
    this.localPhase = 'preparing';
    this.ui?.clearToast();
    this.game.audio.playSe('ui-confirm');
    try {
      const r = await GuestConnector.fromInvite(code);
      if (!this.ui || this.localPhase !== 'preparing') {
        if (r.ok) r.connector.cancel();
        return;
      }
      if (!r.ok) {
        this.localPhase = 'paste';
        this.game.audio.playSe('ui-error');
        this.ui.toast(codeErrorText(r.error, 'invite'));
        return;
      }
      const connector = r.connector;
      this.connector = connector;
      this.localPhase = 'waiting';
      this.isReplyCopied = false;
      this.selected = this.items.indexOf('copyReply');
      connector.onOpen = (transport) => {
        if (this.connector !== connector) return;
        this.joiningTime = 0;
        this.autoJoinAttempts = 0;
        this.autoNameAttempts = 0;
        this.autoNameBase = this.profile.name;
        this.isAutoAdjusted = false;
        this.wantsReady = true;
        this.isReadySent = false;
        const session = new NetClientSession(transport, this.profile, getCourseTrack());
        this.session = session;
        this.isAwaitingJoin = true;
        this.attach(session);
        this.selected = 0;
        this.game.audio.playSe('ui-confirm');
      };
      connector.onFail = (reason) => {
        if (this.connector !== connector || this.session) return;
        const diagnostics = connector.diagnostics();
        this.fail(diagnostics, guestFailureLines(reason, connector.remainingMs <= 0, diagnostics.isSamePublicAddress === true));
      };
      // コピーできる環境 (ページにフォーカスがあるなど) なら自動でコピーする。できなければ「ENTER でコピー」の案内のまま
      void this.copyReply(true);
    } catch {
      this.localPhase = 'paste';
      this.game.audio.playSe('ui-error');
      this.ui?.toast('COULD NOT MAKE A REPLY CODE. RELOAD THE PAGE AND TRY AGAIN.');
    } finally {
      this.isCheckingCode = false;
    }
  }

  private attach(session: NetClientSession): void {
    session.onChange = () => this.onSessionChange(session);
    session.onRaceStart = (race) => this.onRaceStart(session, race);
  }

  private onSessionChange(session: NetClientSession): void {
    if (session !== this.session) return;
    if (this.isAwaitingJoin && session.state === 'rejected' && this.tryAutoRejoin(session)) return;
    if (session.state === 'rejected' || (this.isAwaitingJoin && session.rejectReason)) {
      if (this.isAwaitingJoin && session.rejectReason) {
        this.isAwaitingJoin = false;
        this.game.audio.playSe('ui-error');
        // ロビーにいて変更を断られたときは、知らせて表示を今の自分に戻す (入る前に断られたときは画面の中央に理由を出す)
        const me = session.me;
        if (me && session.state === 'lobby') {
          this.ui?.toast(rejectText(session.rejectReason));
          this.profile = { name: me.name, team: me.team };
          this.ui?.showName(this.profile.name);
        }
      }
      return;
    }
    if (this.isAwaitingJoin && session.me && session.me.name === this.profile.name && session.me.team === this.profile.team) {
      this.isAwaitingJoin = false;
      this.ui?.clearToast();
      if (this.isAutoAdjusted) {
        const team = teamOf(this.profile.team);
        this.ui?.toast(
          `YOUR NAME OR TEAM WAS TAKEN, SO YOU JOINED AS ${this.profile.name} (${team.carNumber} ${team.abbr}). YOU CAN CHANGE THEM ON THE LEFT.`,
          colors.text,
        );
      } else {
        saveNetProfile(this.profile);
      }
    }
    if (session.state === 'closed') this.game.audio.playSe('ui-error');
    this.syncReady(session);
  }

  /**
   * 入るときに名前・チームの重複で断られたら、名前の末尾に数字を付ける・次のチームに変えて入り直す
   * (選び直してもらう手間をなくす)。入り直したら true
   */
  private tryAutoRejoin(session: NetClientSession): boolean {
    const reason = session.rejectReason;
    if ((reason !== 'nameTaken' && reason !== 'teamTaken') || this.autoJoinAttempts >= maxAutoJoinAttempts) return false;
    this.autoJoinAttempts++;
    // 入る前は他の人のチームが分からないので、次のチームを順に試す
    this.profile =
      reason === 'nameTaken'
        ? { ...this.profile, name: alternativeName(this.autoNameBase, this.autoNameAttempts++) }
        : { ...this.profile, team: nextFreeTeam(this.profile.team, 1, []) };
    this.isAutoAdjusted = true;
    this.ui?.showName(this.profile.name);
    this.rejoin();
    return true;
  }

  /** 準備完了を wantsReady に合わせる (入り直すとホスト側で外れるので、そのたびに送り直す) */
  private syncReady(session: NetClientSession): void {
    const me = session.me;
    if (session.state !== 'lobby' || this.isAwaitingJoin || !me) return;
    if (me.isReady === this.wantsReady) {
      this.isReadySent = false;
      return;
    }
    if (this.isReadySent) return;
    this.isReadySent = true;
    session.setReady(this.wantsReady);
  }

  private onRaceStart(session: NetClientSession, race: NetRaceClient): void {
    this.game.changeScene(new NetRaceScene(this.game, { session, host: null }, race));
  }

  private fail(diagnostics: LinkDiagnostics | null, lines: readonly string[]): void {
    this.failureLines = lines;
    this.failureDiagnostics = diagnostics ?? this.connector?.diagnostics() ?? null;
    this.localPhase = 'failed';
    this.connector?.cancel();
    this.connector = null;
    if (this.session) {
      this.session.onChange = null;
      this.session.leave();
      this.session = null;
    }
    this.selected = 0;
    this.game.audio.playSe('ui-error');
  }

  /** 最初 (招待の貼り付け) に戻る */
  private startOver(): void {
    this.connector?.cancel();
    this.connector = null;
    if (this.session) {
      this.session.onChange = null;
      this.session.leave();
      this.session = null;
    }
    this.localPhase = 'paste';
    this.isReplyCopied = false;
    this.failureLines = [];
    this.failureDiagnostics = null;
    this.selected = this.items.indexOf('pasteInvite');
    this.ui?.clearToast();
  }

  // ---- 操作 ----

  private change(item: GuestItem, step: number): void {
    if (item === 'team') this.changeTeam(step);
    else if (item === 'ready') this.toggleReady();
  }

  private confirm(item: GuestItem): void {
    const audio = this.game.audio;
    switch (item) {
      case 'name':
        audio.playSe('ui-confirm');
        this.ui?.focusName();
        break;
      case 'team':
        this.changeTeam(1);
        break;
      case 'ready':
        this.toggleReady();
        break;
      case 'pasteInvite':
        void this.pasteFromClipboard();
        break;
      case 'copyReply':
        void this.copyReply();
        break;
      case 'joinAgain':
        if (this.session) {
          audio.playSe('ui-confirm');
          this.rejoin();
        }
        break;
      case 'copyDetails':
        void this.copyDetails();
        break;
      case 'retry':
        audio.playSe('ui-cancel');
        this.startOver();
        break;
      case 'leave':
      case 'back':
        audio.playSe('ui-cancel');
        this.connector?.cancel();
        this.connector = null;
        this.localPhase = 'paste';
        this.session?.leave();
        this.session = null;
        this.game.changeScene(new MultiplayerScene(this.game, 'join'));
        break;
      case 'ok':
        audio.playSe('ui-confirm');
        this.game.changeScene(new MenuScene(this.game, 'multiplayer'));
        break;
    }
  }

  private selectAndConfirm(index: number): void {
    if (this.ui?.isEditingName) return;
    this.selected = index;
    this.confirm(this.items[index]);
  }

  private commitName(text: string): void {
    const name = text.trim();
    if (name === this.profile.name) return;
    if (!/^[A-Z0-9]{3,8}$/.test(name)) {
      this.ui?.toast(rejectText('invalidName'));
      this.game.audio.playSe('ui-error');
      this.ui?.showName(this.profile.name);
      return;
    }
    const session = this.session;
    if (session?.players.some((p) => p.id !== session.playerId && p.name === name)) {
      this.ui?.toast(rejectText('nameTaken'));
      this.game.audio.playSe('ui-error');
      this.ui?.showName(this.profile.name);
      return;
    }
    this.profile = { ...this.profile, name };
    this.isAutoAdjusted = false;
    this.game.audio.playSe('ui-confirm');
    // ロビーにいるときはすぐ入り直す。断られたあとは JOIN AGAIN で
    if (session?.state === 'lobby') this.rejoin();
    else if (!session) saveNetProfile(this.profile);
  }

  private changeTeam(step: number): void {
    const session = this.session;
    const taken = session && session.state === 'lobby' ? session.players.filter((p) => p.id !== session.playerId).map((p) => p.team) : [];
    const team = nextFreeTeam(this.profile.team, step, taken);
    if (team === this.profile.team) {
      this.game.audio.playSe('ui-error');
      return;
    }
    this.profile = { ...this.profile, team };
    this.isAutoAdjusted = false;
    this.game.audio.playSe('ui-cursor');
    if (session?.state === 'lobby') this.rejoin();
    else if (!session) saveNetProfile(this.profile);
  }

  private rejoin(): void {
    const session = this.session;
    if (!session) return;
    session.rejectReason = null;
    this.isAwaitingJoin = true;
    this.isReadySent = false;
    session.join(this.profile);
  }

  private toggleReady(): void {
    const session = this.session;
    if (!session || session.state !== 'lobby') return;
    this.wantsReady = !(session.me?.isReady ?? this.wantsReady);
    this.isReadySent = false;
    this.syncReady(session);
    this.game.audio.playSe('ui-confirm');
  }

  private async pasteFromClipboard(): Promise<void> {
    const text = await readClipboardText();
    if (text === null || text.trim() === '') {
      this.game.audio.playSe('ui-error');
      this.ui?.toast('COULD NOT READ THE CLIPBOARD. PRESS CTRL+V, OR PASTE THE INVITE LINK INTO THE BOX.');
      return;
    }
    await this.acceptInvite(text);
  }

  /** isAuto = 返答コードができた時点で自動で試す (失敗しても知らせず、ENTER でコピーの案内を出したままにする) */
  private async copyReply(isAuto = false): Promise<void> {
    const code = this.connector?.replyCode;
    if (!code) return;
    const ok = await copyText(code, isAuto ? null : this.replyBox);
    if (isAuto && !ok) return;
    if (ok && this.connector?.replyCode === code) this.isReplyCopied = true;
    this.game.audio.playSe(ok ? 'ui-confirm' : 'ui-error');
    this.ui?.toast(
      ok ? 'REPLY CODE COPIED. SEND IT BACK TO THE HOST.' : 'COULD NOT COPY. SELECT THE CODE IN THE BOX AND PRESS CTRL+C.',
      ok ? colors.hudGreen : colors.yellow,
    );
  }

  private async copyDetails(): Promise<void> {
    const d = this.failureDiagnostics;
    if (!d) {
      this.game.audio.playSe('ui-error');
      return;
    }
    const ok = await copyText(JSON.stringify({ game: 'PIX LIGHTS OUT', ...d }, null, 1), null);
    this.game.audio.playSe(ok ? 'ui-confirm' : 'ui-error');
    this.ui?.toast(ok ? 'DETAILS COPIED (NO IP ADDRESSES).' : 'COULD NOT COPY THE DETAILS.', ok ? colors.hudGreen : colors.yellow);
  }

  // ---- 描画 ----

  /** 画面の上に出す「いま何をすればよいか」(1 行、64 文字まで) */
  private hint(phase: GuestPhase): string {
    switch (phase) {
      case 'paste':
        return 'OPEN THE INVITE LINK FROM THE HOST, OR PASTE IT HERE (CTRL+V)';
      case 'preparing':
        return 'MAKING YOUR REPLY CODE... (UP TO 5 SEC)';
      case 'waiting':
        return this.isReplyCopied ? 'SEND THE REPLY CODE BACK TO THE HOST' : 'PRESS ENTER (OR CLICK) TO COPY THE REPLY CODE';
      case 'joining':
        return 'CONNECTED. JOINING THE LOBBY...';
      case 'lobby':
        if (this.session && !this.session.isCourseCompatible) return 'DIFFERENT COURSE VERSION. EVERYONE SHOULD RELOAD THE PAGE.';
        return this.session?.me?.isReady ? 'YOU ARE READY. WAIT FOR THE HOST TO START THE RACE.' : 'SET "READY" TO YES WHEN YOU ARE READY.';
      case 'rejected':
        return 'CHANGE YOUR NAME OR TEAM, THEN SELECT "JOIN AGAIN".';
      case 'failed':
        return 'NOT CONNECTED. SEE THE GUIDE BELOW.';
      case 'closed':
        return 'DISCONNECTED. PRESS ENTER TO GO BACK.';
    }
  }

  private renderMenu(ctx: CanvasRenderingContext2D, ui: LobbyUi, items: readonly GuestItem[]): void {
    const team = teamOf(this.profile.team);
    const views: MenuItemView[] = items.map((item) => {
      switch (item) {
        case 'team':
          return { label: labels.team, isEnabled: true, value: `${team.carNumber} ${team.abbr}` };
        case 'ready':
          return { label: labels.ready, isEnabled: true, value: this.session?.me?.isReady ? 'YES' : 'NO' };
        case 'copyDetails':
          return { label: labels.copyDetails, isEnabled: this.failureDiagnostics !== null };
        default:
          return { label: labels[item], isEnabled: true };
      }
    });
    drawPanel(ctx, menuX - 4, menuY - 4, menuW + 8, Math.max(4, items.length) * menuRowH + 4);
    ui.drawMenu(ctx, views, this.selected, { x: menuX, y: menuY, width: menuW, rowHeight: menuRowH }, (i) => this.selectAndConfirm(i));
  }

  private renderList(ctx: CanvasRenderingContext2D, session: NetClientSession): void {
    const rows: LobbyRowView[] = [];
    for (let slot = 0; slot < 8; slot++) {
      const player = session.players.find((p) => p.id === slot) ?? null;
      rows.push({
        slot,
        player,
        status: slot === 0 ? 'HOST' : 'OPEN',
        statusColor: colors.midGrey,
        isSelf: player !== null && player.id === session.playerId,
        isSelected: false,
      });
    }
    drawLobbyList(ctx, listX, listY, listW, `PLAYERS ${session.players.length}/8`, rows);
  }

  private renderSteps(ctx: CanvasRenderingContext2D, phase: GuestPhase): void {
    drawPanel(ctx, listX, listY, listW, 230);
    const steps = [
      '1. OPEN THE INVITE LINK FROM THE HOST (OR PASTE IT HERE)',
      '2. COPY YOUR REPLY CODE',
      '3. SEND IT BACK TO THE HOST',
      '4. WAIT UNTIL THE HOST PASTES IT',
    ];
    const current = phase === 'paste' || phase === 'preparing' ? 0 : phase === 'waiting' ? (this.isReplyCopied ? 2 : 1) : 3;
    let y = listY + 12;
    steps.forEach((s, i) => {
      const color = i === current ? colors.white : i < current ? colors.midGrey : colors.subtext;
      y += drawParagraph(ctx, s, listX + 12, y, listW - 24, { color }) + 8;
    });
    const connector = this.connector;
    if (phase === 'waiting' && connector) {
      const left = Math.ceil(connector.remainingMs / 1000);
      const waitText = left > 0 ? `WAITING FOR THE HOST (${left} SEC LEFT)` : 'WAITING FOR THE HOST...';
      drawParagraph(ctx, waitText, listX + 12, listY + 196, listW - 24, { color: colors.cyan });
    }
  }

  private renderCodePanel(ctx: CanvasRenderingContext2D, ui: LobbyUi, phase: GuestPhase): void {
    drawPanel(ctx, codeX, codeY, codeW, codeH);
    const x = codeX + 10;
    const y = codeY + 8;
    const w = codeW - 20;
    const connector = this.connector;
    const showReply = phase === 'waiting' && connector !== null;
    if (this.replyBox) {
      ui.overlay.setVisible(this.replyBox, showReply);
      if (showReply && this.replyBox.value !== connector.replyCode) this.replyBox.value = connector.replyCode;
    }
    if (this.pasteBox) ui.overlay.setVisible(this.pasteBox, phase === 'paste');
    const session = this.session;
    switch (phase) {
      case 'paste':
        drawText(ctx, 'PASTE THE INVITE LINK (OR CODE) FROM THE HOST', x, y, { color: colors.white });
        drawParagraph(ctx, 'OPENING THE LINK DOES THIS FOR YOU. OR PRESS CTRL+V ANYWHERE, SELECT "PASTE INVITE", OR PASTE INTO THE BOX BELOW.', x, y + 28, w, {
          color: colors.text,
        });
        drawParagraph(ctx, 'YOUR NAME AND TEAM CAN BE CHANGED ANY TIME ON THE LEFT.', x, codeY + 160, w, { color: colors.subtext });
        break;
      case 'preparing':
        drawText(ctx, 'PREPARING YOUR REPLY CODE... (UP TO 5 SEC)', x, y, { color: colors.white });
        break;
      case 'waiting': {
        if (!connector) break;
        const isCursorOnCopy = this.items[this.selected] === 'copyReply';
        if (this.isReplyCopied) {
          ui.bigPrompt(ctx, promptRect, ['REPLY CODE COPIED', 'SEND IT BACK TO THE HOST. CLICK HERE TO COPY AGAIN.'], colors.hudGreen, () => void this.copyReply(), 2);
        } else {
          ui.bigPrompt(ctx, promptRect, [isCursorOnCopy ? 'PRESS ENTER (OR CLICK)' : 'CLICK HERE', 'TO COPY THE REPLY CODE'], colors.yellow, () => void this.copyReply());
        }
        ui.button(ctx, { x: buttonX, y: codeY + 70, w: buttonW, h: 26 }, 'COPY', true, () => void this.copyReply());
        let ny = codeY + 112;
        ny += drawParagraph(ctx, netTexts.ipWarning, x, ny, w, { color: colors.subtext }) + 2;
        const gather = connector.gather.analysis;
        if (gather.isStunUnreachable) drawParagraph(ctx, netTexts.stunUnreachable, x, ny, w, { color: colors.yellow, maxLines: 2 });
        else if (gather.isSymmetricNatSuspected) drawParagraph(ctx, netTexts.symmetricNat, x, ny, w, { color: colors.yellow, maxLines: 2 });
        break;
      }
      case 'joining':
        drawText(ctx, 'CONNECTED. JOINING THE LOBBY...', x, y, { color: colors.white });
        break;
      case 'lobby': {
        if (!session) break;
        const laps = session.settings?.laps ?? 3;
        drawText(ctx, `COURSE 1   LAPS ${laps}`, x, y, { color: colors.white });
        const text = session.isCourseCompatible
          ? session.me?.isReady
            ? 'YOU ARE READY. WAITING FOR THE HOST TO START THE RACE. SET "READY" TO NO IF YOU NEED A MOMENT.'
            : 'YOU ARE NOT READY. SET "READY" TO YES SO THE HOST CAN START THE RACE.'
          : 'THE HOST HAS A DIFFERENT COURSE VERSION. EVERYONE SHOULD RELOAD THE PAGE.';
        drawParagraph(ctx, text, x, y + 28, w, { color: session.isCourseCompatible ? colors.text : colors.yellow });
        break;
      }
      case 'rejected':
        drawText(ctx, 'THE HOST COULD NOT ADD YOU', x, y, { color: colors.red });
        if (session?.rejectReason) drawParagraph(ctx, rejectText(session.rejectReason), x, y + 28, w, { color: colors.text });
        drawParagraph(ctx, 'CHANGE YOUR NAME OR TEAM, THEN SELECT "JOIN AGAIN".', x, y + 72, w, { color: colors.subtext });
        break;
      case 'failed':
        drawText(ctx, 'NOT CONNECTED', x, y, { color: colors.red });
        drawParagraph(ctx, this.failureLines, x, y + 28, w, { color: colors.text, maxLines: 8 });
        break;
      case 'closed': {
        drawText(ctx, 'DISCONNECTED', x, y, { color: colors.red });
        const reason = session?.rejectReason;
        const text = reason === 'version' || reason === 'raceInProgress' || reason === 'full' ? rejectText(reason) : closeText(session?.closeReason ?? null);
        drawParagraph(ctx, text, x, y + 28, w, { color: colors.text });
        break;
      }
    }
  }
}
