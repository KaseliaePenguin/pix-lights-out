/**
 * コースデータの形式 (game-design.md 11.3 節)。
 * 中心線は「直線」と「円弧」の並びで書く。向き θ は 0 = 北、時計回りが正 (car-physics.md 2.1 節)。
 * 位置の指定はすべて TrackRef (セグメント名 + 割合 + ずらし量) で書き、中心線の長さを変えても崩れないようにする。
 */

export type RunoffKind = 'grass' | 'gravel';

/** コース端 (白線の外側) からの幅。縁石はこの幅に含まれる */
export interface RunoffSpec {
  kind: RunoffKind;
  width: number;
  /** コーナーの手前に何 px 延ばすか (外側の既定 80、内側の既定 40) */
  lead?: number;
  /** コーナーの先に何 px 延ばすか (外側の既定 200、内側の既定 40) */
  trail?: number;
}

export interface StraightSegment {
  kind: 'straight';
  id?: string;
  length: number;
  width?: number;
}

export interface TurnSegment {
  kind: 'turn';
  id?: string;
  /** 曲がる角度 (度)。正 = 右 (時計回り) */
  angle: number;
  /** 中心線の半径 (px) */
  radius: number;
  width?: number;
  /** 外側のランオフ (既定: 直線と同じ) */
  outside?: RunoffSpec;
  /** 内側のランオフ (既定: 直線と同じ) */
  inside?: RunoffSpec;
  /** 縁石を置くか (既定 true) */
  kerbs?: boolean;
}

export type TrackSegment = StraightSegment | TurnSegment;

/** 中心線上の位置: セグメント id の始点から t (0〜1) の割合 + offset px。最初のセグメントの始点がコントロールライン */
export interface TrackRef {
  seg: string;
  t?: number;
  offset?: number;
}

export interface WidthZone {
  from: TrackRef;
  to: TrackRef;
  width: number;
}

export interface RunoffZone {
  from: TrackRef;
  to: TrackRef;
  side: 'left' | 'right';
  spec: RunoffSpec;
}

export interface PitLaneData {
  /** 路面の幅 (px) */
  width: number;
  /** 両側の芝生の幅 (px) */
  runoff: number;
  /** 経路の制御点。コースの中心線からの横位置 (右が正) で書く。なめらかな曲線でつなぐ */
  points: readonly { at: TrackRef; lateral: number }[];
  /** ピット入口ライン・出口ラインを置く制御点の番号 */
  entryPoint: number;
  exitPoint: number;
}

export interface TrackData {
  id: string;
  name: string;
  /**
   * コースデータのバージョン。形・幅・ランオフ・壁・チェックポイントなど、走りやタイムに影響する変更をしたら上げる。
   * 自己ベストとゴーストは、物理のバージョンとこのバージョンの組 (recordVersionOf) が違えば破棄する
   */
  version: number;
  /** コントロールラインでの進行方向 θ */
  startHeading: number;
  defaultWidth: number;
  lineWidth: number;
  kerbWidth: number;
  /** 縁石をコーナーの円弧の前後に何 px 延ばすか */
  kerbExtend: number;
  /** 直線の両側のランオフ */
  straightRunoff: RunoffSpec;
  /** 別の部分のコースと近いとき、間に残す壁の最小の厚さ (px) */
  minWallThickness: number;
  /** 中心線はコントロールラインから始まり、最後にコントロールラインに戻る (閉じる) */
  segments: readonly TrackSegment[];
  widthZones: readonly WidthZone[];
  runoffZones: readonly RunoffZone[];
  /** 区間 S1・S2 の終わり (S3 の終わりはコントロールライン) */
  sectorEnds: readonly [TrackRef, TrackRef];
  /** ランオフを含めない幅にするチェックポイント (シケインのショートカット対策) */
  narrowGates: readonly TrackRef[];
  drs: { detection: TrackRef; start: TrackRef; end: TrackRef };
  /** ポールポジションの側 (次の 1 コーナーのイン側) */
  gridPoleSide: 'left' | 'right';
  pitLane: PitLaneData;
  /** CPU の基準ラップタイム (腕前 1.0 の実測。M2 で計測して記入する) */
  referenceLapTime: number | null;
}
