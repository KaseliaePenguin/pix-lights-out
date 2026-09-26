import type { NetRoute } from './sdp';

/**
 * event チャンネル (順序保証・再送あり) で送る JSON のメッセージ (network.md「メッセージ一覧」)。
 * 受信したものは必ず parseClientMessage / parseHostMessage で形を確かめてから使う (壊れたもの・知らないものは null)。
 * 時刻はすべてホスト時刻 (ホストの Worker の performance.timeOrigin + performance.now()、ミリ秒)。
 */

/** プレイヤー ID = 枠番号 (0 はホスト本人、1〜7 は参加者) */
export type PlayerId = number;

export type TyreChoice = 'soft' | 'hard';

// ---------------------------------------------------------------- 参加者 → ホスト

export interface JoinMessage {
  type: 'join';
  protocolVersion: number;
  /** 英大文字と数字 3〜8 文字 */
  name: string;
  /** 車番 1〜8 */
  team: number;
}

export interface ReadyMessage {
  type: 'ready';
  isReady: boolean;
  /** ロビーで選ぶスタートタイヤ */
  tyre: TyreChoice;
}

/**
 * 接触の通知。参加者 → ホストでは other = ぶつかった相手、ホスト → 参加者では other = ぶつけてきた相手。
 * impulse は受け取る側 (ホスト → 参加者なら受信者) の車に加える衝撃 (px/秒)
 */
export interface CollisionMessage {
  type: 'collision';
  other: PlayerId;
  impulseX: number;
  impulseY: number;
  /** 接触した時刻 (ホスト時刻 ms)。受信時に 250ms 以上前なら適用しない */
  time: number;
  /** 受け取る側がスピンする向き (+1 = 時計回り、-1 = 反時計回り)。0 または省略ならスピンしない */
  spin?: number;
}

export type ClientMessage = JoinMessage | ReadyMessage | CollisionMessage;

// ---------------------------------------------------------------- ホスト → 参加者

export interface LobbyPlayer {
  id: PlayerId;
  name: string;
  team: number;
  isReady: boolean;
  tyre: TyreChoice;
  /** 接続経路 (ホスト本人・未判定は null) */
  route: NetRoute | null;
  /** 往復遅延 (ms)。ホスト本人・未測定は null */
  rttMs: number | null;
}

export interface LobbySettings {
  /** コースの ID */
  course: string;
  /** コースデータのバージョン (TrackData.version)。違えば一緒に走れない */
  courseVersion: number;
  laps: number;
}

export interface WelcomeMessage {
  type: 'welcome';
  playerId: PlayerId;
  players: LobbyPlayer[];
  settings: LobbySettings;
}

export type RejectReason = 'full' | 'version' | 'nameTaken' | 'teamTaken' | 'invalidName' | 'raceInProgress';

export interface RejectMessage {
  type: 'reject';
  reason: RejectReason;
}

export interface LobbyMessage {
  type: 'lobby';
  players: LobbyPlayer[];
  settings: LobbySettings;
}

export type SessionKind = 'qualifying' | 'race';

export interface RaceStartMessage {
  type: 'raceStart';
  session: SessionKind;
  /** スタート (消灯) の時刻 (ホスト時刻 ms)。各自これに合わせてカウントダウンする */
  startTime: number;
  settings: LobbySettings;
  /** グリッド順のプレイヤー ID (先頭がポールポジション) */
  grid: PlayerId[];
  /** 乱数の種 (演出などを全員でそろえる) */
  seed: number;
}

export type RaceEventKind = 'lap' | 'finish' | 'disqualified' | 'retired' | 'ghost' | 'unghost' | 'disconnected' | 'penalty';

export interface RaceEventMessage {
  type: 'raceEvent';
  event: RaceEventKind;
  playerId: PlayerId;
  /** 起きた時刻 (ホスト時刻 ms) */
  time: number;
  /** 周回数 (lap / finish のとき) */
  lap?: number;
  /** 周回タイム・ペナルティ秒など、種類ごとの値 */
  value?: number;
}

export type ResultStatus = 'finished' | 'unclassified' | 'retired' | 'disqualified';

export interface ResultEntry {
  playerId: PlayerId;
  position: number;
  status: ResultStatus;
  /** ゴールタイム (秒、ペナルティ込み)。ゴールしていなければ null */
  totalTime: number | null;
  bestLap: number | null;
  /** 終えた周回数 */
  lapsCompleted: number;
  /** ペナルティ (秒、フライングで +3) */
  penalty: number;
}

export interface ResultMessage {
  type: 'result';
  session: SessionKind;
  entries: ResultEntry[];
}

export interface HostClosedMessage {
  type: 'hostClosed';
}

export type HostMessage =
  | WelcomeMessage | RejectMessage | LobbyMessage | RaceStartMessage
  | RaceEventMessage | ResultMessage | CollisionMessage | HostClosedMessage;

// ---------------------------------------------------------------- 形の確認

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isStr = (v: unknown, maxLength: number): v is string => typeof v === 'string' && v.length <= maxLength;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const isOneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const isPlayerId = (v: unknown): v is PlayerId => isInt(v, 0, 7);
const isList = <T>(v: unknown, max: number, item: (x: unknown) => x is T): v is T[] =>
  Array.isArray(v) && v.length <= max && v.every(item);

const tyres: readonly TyreChoice[] = ['soft', 'hard'];
const routes: readonly NetRoute[] = ['lan', 'internet'];
const rejectReasons: readonly RejectReason[] = ['full', 'version', 'nameTaken', 'teamTaken', 'invalidName', 'raceInProgress'];
const sessions: readonly SessionKind[] = ['qualifying', 'race'];
const raceEvents: readonly RaceEventKind[] = ['lap', 'finish', 'disqualified', 'retired', 'ghost', 'unghost', 'disconnected', 'penalty'];
const resultStatuses: readonly ResultStatus[] = ['finished', 'unclassified', 'retired', 'disqualified'];

/** 名前は英大文字と数字 3〜8 文字 (game-design.md 4.1 節) */
export function isValidPlayerName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Z0-9]{3,8}$/.test(name);
}

function isLobbyPlayer(v: unknown): v is LobbyPlayer {
  return isObj(v) && isPlayerId(v.id) && isValidPlayerName(v.name) && isInt(v.team, 1, 8) && isBool(v.isReady)
    && isOneOf(v.tyre, tyres) && (v.route === null || isOneOf(v.route, routes)) && isNumOrNull(v.rttMs);
}

function isSettings(v: unknown): v is LobbySettings {
  return isObj(v) && isStr(v.course, 32) && isInt(v.courseVersion, 0, 1e9) && isInt(v.laps, 1, 99);
}

function isResultEntry(v: unknown): v is ResultEntry {
  return isObj(v) && isPlayerId(v.playerId) && isInt(v.position, 1, 8) && isOneOf(v.status, resultStatuses)
    && isNumOrNull(v.totalTime) && isNumOrNull(v.bestLap) && isInt(v.lapsCompleted, 0, 999) && isNum(v.penalty);
}

/** collision の衝撃 (px/秒) の形の上の上限。これを超えるものは壊れた・不正なメッセージ */
const maxImpulseInMessage = 10000;

function isCollision(v: Obj): boolean {
  // 衝撃の大きさは物理上の上限 (netRaceRules.collisionImpulseMax) より十分大きい値で切る。細かい上限はホストの中継で見る
  return isPlayerId(v.other) && isNum(v.impulseX) && isNum(v.impulseY) && Math.hypot(v.impulseX, v.impulseY) <= maxImpulseInMessage
    && isNum(v.time) && (v.spin === undefined || isInt(v.spin, -1, 1));
}

function parseJson(text: string): Obj | null {
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** ホストが受け取ったメッセージを確かめる。不正なら null (送り主を切断する) */
export function parseClientMessage(text: string): ClientMessage | null {
  const v = parseJson(text);
  if (!v) return null;
  switch (v.type) {
    case 'join':
      // 名前の規則違反は reject で知らせるので、ここでは文字列であることだけ確かめる
      return isInt(v.protocolVersion, 0, 65535) && isStr(v.name, 32) && isInt(v.team, 1, 8) ? (v as unknown as JoinMessage) : null;
    case 'ready':
      return isBool(v.isReady) && isOneOf(v.tyre, tyres) ? (v as unknown as ReadyMessage) : null;
    case 'collision':
      return isCollision(v) ? (v as unknown as CollisionMessage) : null;
    default:
      return null;
  }
}

/** 参加者が受け取ったメッセージを確かめる。不正なら null (捨てる) */
export function parseHostMessage(text: string): HostMessage | null {
  const v = parseJson(text);
  if (!v) return null;
  let isValid = false;
  switch (v.type) {
    case 'welcome':
      isValid = isPlayerId(v.playerId) && isList(v.players, 8, isLobbyPlayer) && isSettings(v.settings);
      break;
    case 'reject':
      isValid = isOneOf(v.reason, rejectReasons);
      break;
    case 'lobby':
      isValid = isList(v.players, 8, isLobbyPlayer) && isSettings(v.settings);
      break;
    case 'raceStart':
      isValid = isOneOf(v.session, sessions) && isNum(v.startTime) && isSettings(v.settings)
        && isList(v.grid, 8, isPlayerId) && new Set(v.grid).size === v.grid.length && isInt(v.seed, 0, 0xffffffff);
      break;
    case 'raceEvent':
      isValid = isOneOf(v.event, raceEvents) && isPlayerId(v.playerId) && isNum(v.time)
        && (v.lap === undefined || isInt(v.lap, 0, 999)) && (v.value === undefined || isNum(v.value));
      break;
    case 'result':
      isValid = isOneOf(v.session, sessions) && isList(v.entries, 8, isResultEntry);
      break;
    case 'collision':
      isValid = isCollision(v);
      break;
    case 'hostClosed':
      isValid = true;
      break;
  }
  return isValid ? (v as unknown as HostMessage) : null;
}
