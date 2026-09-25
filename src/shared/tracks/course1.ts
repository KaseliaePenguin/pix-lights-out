import type { RunoffSpec, TrackData } from '../trackData';

const grass = (width: number, lead?: number, trail?: number): RunoffSpec => ({ kind: 'grass', width, lead, trail });
const gravel = (width: number, lead?: number, trail?: number): RunoffSpec => ({ kind: 'gravel', width, lead, trail });

/** ヘアピンの内側で、両側の直線の間に壁を置かない範囲 (円弧の前後、px。game-design.md 11.2 節「近い場所」) */
const hairpinOpenInside = 300;

/**
 * コース 1 (仮称)。game-design.md 第 4 版 11.2 節の値をそのまま使う (拡大しない)。
 * 時計回り、コントロールラインで北向き。radius は中心線の半径。
 * st3・st4 の長さは形が閉じるように計算した値 (11.2 節「閉じることの確かめ方」)。
 *
 * 仕様からの変更 (ユーザーの要望「U 字コーナーが曲がりづらい」とユーザーの yawMaxLow 2.0 に合わせて、コース側を緩やかにした):
 * 半径 T6 90→120、T7 55→140、T8 40→70 (幅 90 で内側の端が中心を越えていたため)、T9 100→130、T11 120→160。
 * 閉じるように st3 2534.3→2730、st4 2334.9→2182.2。
 * S 字 (T2・T3) の内側を横切る近道 (見積もり約 0.27 秒得) を小さくするため、内側を芝生 30 → 砂利 40 にした (残りは約 0.17 秒以下の見積もり)
 */
export const course1: TrackData = {
  id: 'course1',
  name: 'COURSE 1',
  // 1: 最初の版 / 2: ヘアピンの間の壁の修正、区間 S1 の境界の変更 / 3: 第 4 版で作り直し
  version: 3,
  startHeading: 0,
  defaultWidth: 80,
  lineWidth: 4,
  kerbWidth: 8,
  kerbExtend: 30,
  straightRunoff: grass(60),
  minWallThickness: 24,
  segments: [
    { kind: 'straight', id: 'main1', length: 1900 },
    { kind: 'turn', id: 'T1', angle: 90, radius: 60, outside: gravel(160, 120, 200), inside: grass(30) },
    { kind: 'straight', id: 'st1', length: 900 },
    { kind: 'turn', id: 'T2', angle: -90, radius: 70, outside: grass(120), inside: gravel(40) },
    { kind: 'straight', id: 'st2', length: 200 },
    { kind: 'turn', id: 'T3', angle: 90, radius: 70, outside: grass(120), inside: gravel(40) },
    { kind: 'straight', id: 'st3', length: 2730 },
    { kind: 'turn', id: 'T4', angle: 90, radius: 120, outside: grass(160), inside: grass(30) },
    { kind: 'straight', id: 'st4', length: 2182.2 },
    { kind: 'turn', id: 'T5', angle: 40, radius: 400, outside: grass(150), inside: grass(30) },
    { kind: 'straight', id: 'st5', length: 200 },
    { kind: 'turn', id: 'T6', angle: -100, radius: 120, outside: grass(120), inside: grass(30) },
    { kind: 'straight', id: 'st6', length: 400 },
    {
      kind: 'turn', id: 'T7', angle: 150, radius: 140, width: 100,
      outside: gravel(180, 150, 250), inside: gravel(40), openInside: hairpinOpenInside,
    },
    { kind: 'straight', id: 'back', length: 2800 },
    { kind: 'turn', id: 'T8', angle: 90, radius: 70, outside: gravel(160, 120, 200), inside: grass(30) },
    { kind: 'straight', id: 'st8', length: 1400 },
    { kind: 'turn', id: 'T9', angle: -135, radius: 130, outside: grass(130), inside: gravel(40) },
    { kind: 'straight', id: 'st9', length: 800 },
    { kind: 'turn', id: 'T10', angle: -45, radius: 200, outside: grass(60), inside: grass(30) },
    { kind: 'straight', id: 'st10', length: 700 },
    {
      kind: 'turn', id: 'T11', angle: 180, radius: 160, width: 100,
      outside: gravel(150), inside: gravel(40), openInside: hairpinOpenInside,
    },
    { kind: 'straight', id: 'main0', length: 900 },
  ],
  widthZones: [
    // 最高速からのブレーキングゾーンは 90 px、ヘアピンの手前と弧は 100 px
    { from: { seg: 'main1', t: 1, offset: -400 }, to: { seg: 'T1', t: 1 }, width: 90 },
    { from: { seg: 'back', t: 1, offset: -400 }, to: { seg: 'T8', t: 1 }, width: 90 },
    { from: { seg: 'st6', t: 1, offset: -300 }, to: { seg: 'T7', t: 1, offset: 100 }, width: 100 },
    { from: { seg: 'st10', t: 1, offset: -300 }, to: { seg: 'T11', t: 1, offset: 100 }, width: 100 },
  ],
  runoffZones: [],
  sectorEnds: [
    { seg: 'T4', t: 1, offset: 60 },
    { seg: 'back', t: 0.75 },
  ],
  narrowGates: [],
  drs: {
    detection: { seg: 'T7', t: 0, offset: -150 },
    start: { seg: 'back', t: 0, offset: 150 },
    end: { seg: 'T8', t: 0, offset: -150 },
  },
  gridPoleSide: 'right',
  // メインストレートの左側 (周回の外側、中心線から 110 px)。入口は main0 の約 28%、出口は main1 の約 53% (8.3 節)
  pitLane: {
    width: 64,
    runoff: 16,
    points: [
      { at: { seg: 'main0', t: 0.28 }, lateral: -38 },
      { at: { seg: 'main0', t: 0.28, offset: 250 }, lateral: -110 },
      { at: { seg: 'main0', t: 0.28, offset: 400 }, lateral: -110 },
      { at: { seg: 'main1', t: 0 }, lateral: -110 },
      { at: { seg: 'main1', t: 0.53, offset: -400 }, lateral: -110 },
      { at: { seg: 'main1', t: 0.53, offset: -250 }, lateral: -110 },
      { at: { seg: 'main1', t: 0.53 }, lateral: -38 },
    ],
    entryPoint: 1,
    exitPoint: 5,
  },
  referenceLapTime: null,
};
