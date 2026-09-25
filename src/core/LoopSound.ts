/** ループ音の追従の速さ (秒)。setTargetAtTime の時定数で、約 3 倍の時間で目標にほぼ届く */
export interface LoopTiming {
  /** 音量を上げるとき・再生速度を変えるとき (既定 0.015 = 約 45 ms) */
  attack?: number;
  /** 音量を下げるときに目標へほぼ届くまでの時間 (秒、既定 0.1) */
  release?: number;
}

const defaultAttack = 0.015;
const defaultRelease = 0.1;
/** これより小さい変化は予約しない (毎フレーム同じ値を積まないため) */
const epsilon = 0.0005;

/**
 * 鳴らし続けるループ音 (エンジン・スキール・路面・擦りなど)。作った時点で音量 0 で再生を始め、
 * 毎フレーム set(volume, rate) で音量と再生速度を変える。値は setTargetAtTime でなめらかに追従する。
 * 音声が読めなかった・Web Audio が使えないときは、何も鳴らさない空の LoopSound になる。
 */
export class LoopSound {
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private volume = 0;
  private rate = 1;
  private readonly attack: number;
  private readonly releaseConstant: number;

  constructor(
    private readonly context: AudioContext | null,
    buffer: AudioBuffer | null,
    destination: AudioNode | null,
    /** 設定テーブルの基準音量。set の volume に掛ける */
    private readonly baseVolume: number,
    timing: LoopTiming = {},
    highShelfDb = 0,
  ) {
    this.attack = timing.attack ?? defaultAttack;
    this.releaseConstant = (timing.release ?? defaultRelease) / 3;
    if (!context || !buffer || !destination) return;
    this.gain = context.createGain();
    this.gain.gain.value = 0;
    let output: AudioNode = this.gain;
    if (highShelfDb !== 0) {
      this.filter = context.createBiquadFilter();
      this.filter.type = 'highshelf';
      this.filter.frequency.value = 4000;
      this.filter.gain.value = highShelfDb;
      this.gain.connect(this.filter);
      output = this.filter;
    }
    output.connect(destination);
    this.source = context.createBufferSource();
    this.source.buffer = buffer;
    this.source.loop = true;
    this.source.connect(this.gain);
    // 同じ素材を複数鳴らしたときに位相が揃わないよう、開始位置をずらす
    this.source.start(0, Math.random() * buffer.duration);
  }

  /** 音が出せる状態か (読み込みに失敗していれば false。呼び出し側は気にせず set を呼んでよい) */
  get isPlayable(): boolean {
    return this.source !== null;
  }

  /** volume は 0〜1 (基準音量に掛ける。1 を超えてもよい)、rate は再生速度 */
  set(volume: number, rate: number = this.rate): void {
    this.setVolume(volume);
    this.setRate(rate);
  }

  setVolume(volume: number): void {
    if (!this.gain || !this.context) return;
    const v = Math.max(0, volume);
    if (Math.abs(v - this.volume) < epsilon) return;
    const constant = v < this.volume ? this.releaseConstant : this.attack;
    this.volume = v;
    this.gain.gain.setTargetAtTime(v * this.baseVolume, this.context.currentTime, constant);
  }

  setRate(rate: number): void {
    if (!this.source || !this.context) return;
    // 0.5 未満・2.0 超は音質の劣化が目立つ (sound-guide.md 3 章)
    const r = Math.min(2, Math.max(0.5, rate));
    if (Math.abs(r - this.rate) < epsilon) return;
    this.rate = r;
    this.source.playbackRate.setTargetAtTime(r, this.context.currentTime, this.attack);
  }

  /** 短くフェードアウトして止める。止めたあとは何もしない */
  stop(fadeTime = 0.05): void {
    if (!this.source || !this.gain || !this.context) return;
    const now = this.context.currentTime;
    this.gain.gain.setTargetAtTime(0, now, Math.max(0.001, fadeTime / 3));
    const source = this.source;
    const gain = this.gain;
    const filter = this.filter;
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      filter?.disconnect();
    };
    source.stop(now + fadeTime);
    this.source = null;
    this.gain = null;
    this.filter = null;
  }
}
