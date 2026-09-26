import { isNewerSeq, readStateSeq, readStateType, stateType, writeStateSeq } from './stateCodec';

/**
 * state チャンネルの連番 (1 本の接続の片側ぶん)。送るときに carState・snapshot へ連番を書き込み、
 * 受けたときは種類ごとに最新より古いものを捨てる (順序保証なしのため)。ping・pong は対象外 (自分の連番を持つ)
 */
export class StateSequencer {
  private sendSeq = 0;
  private readonly lastReceived = new Float64Array(5).fill(-1);

  /** 送る前に呼ぶ。data の連番を書き換える */
  stamp(data: ArrayBuffer): void {
    const type = readStateType(data);
    if (type !== stateType.carState && type !== stateType.snapshot) return;
    this.sendSeq = (this.sendSeq + 1) >>> 0;
    writeStateSeq(data, this.sendSeq);
  }

  /** 受けたときに呼ぶ。古い (または同じ) 連番なら false */
  accept(data: ArrayBuffer): boolean {
    const type = readStateType(data);
    if (type === null) return false;
    if (type !== stateType.carState && type !== stateType.snapshot) return true;
    const seq = readStateSeq(data);
    const last = this.lastReceived[type];
    if (last >= 0 && !isNewerSeq(seq, last)) return false;
    this.lastReceived[type] = seq;
    return true;
  }
}
