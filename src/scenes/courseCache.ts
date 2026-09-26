import { carParams } from '../shared/carParams';
import { RacingLine } from '../shared/RacingLine';
import { Track } from '../shared/Track';
import { course1 } from '../shared/tracks/course1';
import { Minimap } from '../ui/Minimap';

/**
 * コースと、コースから作る重いもの (ミニマップの絵・CPU のレーシングライン) を起動中に 1 回だけ作って使い回す。
 * Track は約 0.5 秒、RacingLine は約 0.3 秒かかるため、リスタートや画面の行き来で作り直さない。
 * M2 はコース 1 だけ。
 */
let cachedTrack: Track | null = null;
let cachedMinimap: Minimap | null = null;
let cachedRacingLine: RacingLine | null = null;

export function getCourseTrack(): Track {
  cachedTrack ??= new Track(course1);
  return cachedTrack;
}

export function getCourseMinimap(): Minimap {
  cachedMinimap ??= new Minimap(getCourseTrack());
  return cachedMinimap;
}

/** 決勝の CPU が追う線 (M2 はソフト固定なので、ソフトのグリップで作る。RaceSession の既定と同じ条件) */
export function getCourseRacingLine(): RacingLine {
  cachedRacingLine ??= new RacingLine(getCourseTrack(), { tyreGrip: carParams.compoundGrip.soft, params: carParams });
  return cachedRacingLine;
}
