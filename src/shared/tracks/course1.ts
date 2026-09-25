import type { RunoffSpec, TrackData, TrackSegment } from '../trackData';

const grass = (width: number, lead?: number, trail?: number): RunoffSpec => ({ kind: 'grass', width, lead, trail });
const gravel = (width: number, lead?: number, trail?: number): RunoffSpec => ({ kind: 'gravel', width, lead, trail });

/**
 * 形を保ったまま 1 周を約 17,800 px (game-design.md 11.1 節) にするための倍率。
 * 直線の長さとコーナーの半径にかける (コース幅・ランオフの幅は変えない)
 */
const layoutScale = 1.0665;

function scaled(segments: TrackSegment[]): TrackSegment[] {
  return segments.map((seg) =>
    seg.kind === 'straight'
      ? { ...seg, length: seg.length * layoutScale }
      : { ...seg, radius: seg.radius * layoutScale },
  );
}

/**
 * コース 1 (仮称)。game-design.md 11.2 節のレイアウト案をもとに、閉じた形になるよう
 * 曲がる向きと一部の角度・直線の長さを調整したもの。時計回り、コントロールラインで北向き。
 * radius は中心線の半径 (レーシングラインの半径は、コース幅を使う分だけ大きくなる)。
 * 下の数値は layoutScale をかける前のもの。
 */
export const course1: TrackData = {
  id: 'course1',
  name: 'COURSE 1',
  startHeading: 0,
  defaultWidth: 60,
  lineWidth: 4,
  kerbWidth: 8,
  kerbExtend: 30,
  straightRunoff: grass(40),
  minWallThickness: 24,
  segments: scaled([
    { kind: 'straight', id: 'main1', length: 1927 },
    { kind: 'turn', id: 'T1', angle: 90, radius: 45, outside: gravel(150, 120, 200) },
    { kind: 'straight', id: 'st1', length: 1477 },
    { kind: 'turn', id: 'T2', angle: 40, radius: 500, outside: grass(70) },
    { kind: 'straight', id: 'st2', length: 188 },
    { kind: 'turn', id: 'T3', angle: -40, radius: 500, outside: grass(70) },
    { kind: 'straight', id: 'st3', length: 188 },
    { kind: 'turn', id: 'T4', angle: 40, radius: 500, outside: grass(70) },
    { kind: 'straight', id: 'st4', length: 1985 },
    { kind: 'turn', id: 'T5', angle: -72.8, radius: 136, outside: grass(120) },
    { kind: 'straight', id: 'st5', length: 1118 },
    { kind: 'turn', id: 'T6', angle: 180, radius: 60, width: 70, outside: gravel(160, 150, 250), inside: grass(20) },
    { kind: 'straight', id: 'back', length: 2750 },
    { kind: 'turn', id: 'T7', angle: -60, radius: 70, width: 50, outside: gravel(100), inside: gravel(60) },
    { kind: 'straight', id: 'st7', length: 88, width: 50 },
    { kind: 'turn', id: 'T8', angle: 60, radius: 70, width: 50, outside: gravel(100), inside: gravel(60) },
    { kind: 'straight', id: 'st8', length: 903 },
    { kind: 'turn', id: 'T9', angle: 103, radius: 293, outside: grass(150) },
    { kind: 'straight', id: 'st9', length: 920 },
    { kind: 'turn', id: 'T10', angle: -87.3, radius: 56, outside: grass(100) },
    { kind: 'straight', id: 'st10', length: 520 },
    { kind: 'turn', id: 'T11', angle: -67.9, radius: 44, outside: grass(90) },
    { kind: 'straight', id: 'st11', length: 313 },
    { kind: 'turn', id: 'T12', angle: 82.4, radius: 84, outside: grass(100) },
    { kind: 'straight', id: 'st12', length: 772 },
    { kind: 'turn', id: 'T13', angle: 92.7, radius: 143, outside: grass(120) },
    { kind: 'straight', id: 'main0', length: 899 },
  ]),
  widthZones: [
    // 1 コーナー手前・ヘアピン手前のブレーキングゾーンは 70 px (並んで抜きやすくする)
    { from: { seg: 'main1', t: 1, offset: -400 }, to: { seg: 'T1', t: 0 }, width: 70 },
    { from: { seg: 'st5', t: 1, offset: -400 }, to: { seg: 'T6', t: 1 }, width: 70 },
  ],
  runoffZones: [],
  sectorEnds: [
    { seg: 'T5', t: 1, offset: 60 },
    { seg: 'T8', t: 1, offset: 60 },
  ],
  // シケインの真ん中はコース幅だけのゲートにして、イン側のショートカットを無効にする
  narrowGates: [{ seg: 'st7', t: 0.5 }],
  drs: {
    detection: { seg: 'T6', t: 0, offset: -150 },
    start: { seg: 'back', t: 0, offset: 150 },
    end: { seg: 'T7', t: 0, offset: -120 },
  },
  gridPoleSide: 'right',
  pitLane: {
    width: 64,
    runoff: 16,
    points: [
      { at: { seg: 'st12', t: 0.35 }, lateral: 28 },
      { at: { seg: 'st12', t: 0.7 }, lateral: 75 },
      { at: { seg: 'T13', t: 0.5 }, lateral: 100 },
      { at: { seg: 'main0', t: 0.3 }, lateral: 100 },
      { at: { seg: 'main1', t: 0 }, lateral: 100 },
      { at: { seg: 'main1', t: 0.8 }, lateral: 100 },
      { at: { seg: 'st1', t: 0, offset: 250 }, lateral: 100 },
      { at: { seg: 'st1', t: 0, offset: 450 }, lateral: 55 },
      { at: { seg: 'st1', t: 0, offset: 650 }, lateral: 28 },
    ],
    entryPoint: 1,
    exitPoint: 7,
  },
  referenceLapTime: null,
};
