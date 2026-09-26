import type { PlayerId } from './messages';
import { maxPlayers, stateMaxBytes } from './protocol';

/**
 * state チャンネル (順序保証なし・再送なし) のバイナリ形式 (network.md「DataChannel は 2 本」)。
 * 先頭は共通で [種類 u8][連番 u32]、多バイトはビッグエンディアン。
 *
 *   carState (参加者 → ホスト): 共通 5 + 時刻 f64 + 車 1 台 25                      = 38 バイト
 *   snapshot (ホスト → 全員):   共通 5 + ホスト時刻 f64 + 台数 u8 + 車 25 × 台数     = 8 台で 214 バイト
 *   ping:                       共通 5 + 送った時刻 f64                                = 13 バイト
 *   pong:                       共通 5 (連番は ping と同じ) + ping の時刻 f64 + 返した側の時刻 f64 = 21 バイト
 *   車 1 台: ID u8 / フラグ u8 / x, y, heading, sF, sR f32 / steer i8 / 周回 u8 / 次のチェックポイント u8
 *
 * carState・snapshot の連番は Transport が送るときに書き込む (encode では 0)。受信側の Transport は種類ごとに
 * 最新より古い連番を捨てる。ping・pong の連番は PingSession が付け、往復の対応付けに使う。
 */

export const stateType = { carState: 1, snapshot: 2, ping: 3, pong: 4 } as const;
export type StateType = (typeof stateType)[keyof typeof stateType];

/** ネットワークで送る車 1 台の状態 */
export interface CarNetState {
  id: PlayerId;
  x: number;
  y: number;
  /** 車体の向き (Car.heading) */
  heading: number;
  /** 車体から見た前方向・右方向の速度 (Car.sF / sR、px/秒) */
  sF: number;
  sR: number;
  /** ステア -1〜1 (送るときに 1/127 単位に丸める) */
  steer: number;
  /** 終えた周回数 (0〜255) */
  lap: number;
  /** 次に通るチェックポイントの番号 (0〜255) */
  checkpoint: number;
  isDrsOpen: boolean;
  isBraking: boolean;
  isReversing: boolean;
  isGhost: boolean;
  isInPit: boolean;
  isSpinning: boolean;
}

export interface CarStateMessage {
  seq: number;
  /** 送った側が推定したホスト時刻 (ms) */
  time: number;
  readonly car: CarNetState;
}

export interface SnapshotMessage {
  seq: number;
  hostTime: number;
  /** 有効な台数 (cars の先頭 count 台) */
  count: number;
  /** 受信側で使い回す。maxPlayers 台分を用意しておく */
  readonly cars: CarNetState[];
}

export interface PingMessage {
  seq: number;
  /** ping を送った側の時刻 (ms) */
  sentAt: number;
}

export interface PongMessage {
  seq: number;
  /** ping に書かれていた時刻をそのまま返す */
  sentAt: number;
  /** pong を返した側の時刻 (ms) */
  repliedAt: number;
}

const commonBytes = 5;
const carBytes = 25;
const carStateBytes = commonBytes + 8 + carBytes;
const snapshotHeaderBytes = commonBytes + 8 + 1;
const pingBytes = commonBytes + 8;
const pongBytes = commonBytes + 16;

const flagDrs = 1;
const flagBraking = 2;
const flagReversing = 4;
const flagGhost = 8;
const flagPit = 16;
const flagSpinning = 32;

export function createCarNetState(id: PlayerId = 0): CarNetState {
  return {
    id, x: 0, y: 0, heading: 0, sF: 0, sR: 0, steer: 0, lap: 0, checkpoint: 0,
    isDrsOpen: false, isBraking: false, isReversing: false, isGhost: false, isInPit: false, isSpinning: false,
  };
}

export function createCarStateMessage(): CarStateMessage {
  return { seq: 0, time: 0, car: createCarNetState() };
}

export function createSnapshotMessage(): SnapshotMessage {
  const cars: CarNetState[] = [];
  for (let i = 0; i < maxPlayers; i++) cars.push(createCarNetState(i));
  return { seq: 0, hostTime: 0, count: 0, cars };
}

const clampInt = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));

function writeCar(view: DataView, o: number, c: CarNetState): void {
  view.setUint8(o, c.id);
  view.setUint8(o + 1,
    (c.isDrsOpen ? flagDrs : 0) | (c.isBraking ? flagBraking : 0) | (c.isReversing ? flagReversing : 0)
    | (c.isGhost ? flagGhost : 0) | (c.isInPit ? flagPit : 0) | (c.isSpinning ? flagSpinning : 0));
  view.setFloat32(o + 2, c.x);
  view.setFloat32(o + 6, c.y);
  view.setFloat32(o + 10, c.heading);
  view.setFloat32(o + 14, c.sF);
  view.setFloat32(o + 18, c.sR);
  view.setInt8(o + 22, clampInt(c.steer * 127, -127, 127));
  view.setUint8(o + 23, clampInt(c.lap, 0, 255));
  view.setUint8(o + 24, clampInt(c.checkpoint, 0, 255));
}

/** 壊れた値 (ID の範囲外、NaN・無限大) なら false */
function readCar(view: DataView, o: number, c: CarNetState): boolean {
  const id = view.getUint8(o);
  if (id >= maxPlayers) return false;
  const flags = view.getUint8(o + 1);
  c.id = id;
  c.x = view.getFloat32(o + 2);
  c.y = view.getFloat32(o + 6);
  c.heading = view.getFloat32(o + 10);
  c.sF = view.getFloat32(o + 14);
  c.sR = view.getFloat32(o + 18);
  c.steer = view.getInt8(o + 22) / 127;
  c.lap = view.getUint8(o + 23);
  c.checkpoint = view.getUint8(o + 24);
  c.isDrsOpen = (flags & flagDrs) !== 0;
  c.isBraking = (flags & flagBraking) !== 0;
  c.isReversing = (flags & flagReversing) !== 0;
  c.isGhost = (flags & flagGhost) !== 0;
  c.isInPit = (flags & flagPit) !== 0;
  c.isSpinning = (flags & flagSpinning) !== 0;
  return Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.heading)
    && Number.isFinite(c.sF) && Number.isFinite(c.sR);
}

function begin(type: StateType, bytes: number, seq: number): DataView {
  const view = new DataView(new ArrayBuffer(bytes));
  view.setUint8(0, type);
  view.setUint32(1, seq >>> 0);
  return view;
}

/** 種類。短すぎる・知らない種類・上限を超える大きさなら null */
export function readStateType(data: ArrayBuffer): StateType | null {
  if (data.byteLength < commonBytes || data.byteLength > stateMaxBytes) return null;
  const t = new Uint8Array(data, 0, 1)[0];
  return t >= 1 && t <= 4 ? (t as StateType) : null;
}

export function readStateSeq(data: ArrayBuffer): number {
  return new DataView(data).getUint32(1);
}

export function writeStateSeq(data: ArrayBuffer, seq: number): void {
  new DataView(data).setUint32(1, seq >>> 0);
}

/** 連番 a が b より新しいか (u32 の一周を考える) */
export function isNewerSeq(a: number, b: number): boolean {
  const d = (a - b) >>> 0;
  return d !== 0 && d < 0x80000000;
}

export function encodeCarState(time: number, car: CarNetState): ArrayBuffer {
  const view = begin(stateType.carState, carStateBytes, 0);
  view.setFloat64(5, time);
  writeCar(view, 13, car);
  return view.buffer as ArrayBuffer;
}

export function decodeCarState(data: ArrayBuffer, out: CarStateMessage): boolean {
  if (data.byteLength !== carStateBytes || readStateType(data) !== stateType.carState) return false;
  const view = new DataView(data);
  out.seq = view.getUint32(1);
  out.time = view.getFloat64(5);
  return Number.isFinite(out.time) && readCar(view, 13, out.car);
}

export function encodeSnapshot(hostTime: number, cars: readonly CarNetState[], count = cars.length): ArrayBuffer {
  if (count > maxPlayers) throw new Error(`too many cars: ${count}`);
  const view = begin(stateType.snapshot, snapshotHeaderBytes + carBytes * count, 0);
  view.setFloat64(5, hostTime);
  view.setUint8(13, count);
  for (let i = 0; i < count; i++) writeCar(view, snapshotHeaderBytes + carBytes * i, cars[i]);
  return view.buffer as ArrayBuffer;
}

export function decodeSnapshot(data: ArrayBuffer, out: SnapshotMessage): boolean {
  if (readStateType(data) !== stateType.snapshot || data.byteLength < snapshotHeaderBytes) return false;
  const view = new DataView(data);
  const count = view.getUint8(13);
  if (count > maxPlayers || data.byteLength !== snapshotHeaderBytes + carBytes * count) return false;
  out.seq = view.getUint32(1);
  out.hostTime = view.getFloat64(5);
  out.count = count;
  while (out.cars.length < count) out.cars.push(createCarNetState());
  for (let i = 0; i < count; i++) if (!readCar(view, snapshotHeaderBytes + carBytes * i, out.cars[i])) return false;
  return Number.isFinite(out.hostTime);
}

export function encodePing(seq: number, sentAt: number): ArrayBuffer {
  const view = begin(stateType.ping, pingBytes, seq);
  view.setFloat64(5, sentAt);
  return view.buffer as ArrayBuffer;
}

export function decodePing(data: ArrayBuffer, out: PingMessage): boolean {
  if (data.byteLength !== pingBytes || readStateType(data) !== stateType.ping) return false;
  const view = new DataView(data);
  out.seq = view.getUint32(1);
  out.sentAt = view.getFloat64(5);
  return Number.isFinite(out.sentAt);
}

export function encodePong(seq: number, sentAt: number, repliedAt: number): ArrayBuffer {
  const view = begin(stateType.pong, pongBytes, seq);
  view.setFloat64(5, sentAt);
  view.setFloat64(13, repliedAt);
  return view.buffer as ArrayBuffer;
}

export function decodePong(data: ArrayBuffer, out: PongMessage): boolean {
  if (data.byteLength !== pongBytes || readStateType(data) !== stateType.pong) return false;
  const view = new DataView(data);
  out.seq = view.getUint32(1);
  out.sentAt = view.getFloat64(5);
  out.repliedAt = view.getFloat64(13);
  return Number.isFinite(out.sentAt) && Number.isFinite(out.repliedAt);
}
