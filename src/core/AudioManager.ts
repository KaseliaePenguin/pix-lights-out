import type { Assets } from './Assets';
import { EngineSound } from './EngineSound';
import type { EngineSoundOptions } from './EngineSound';
import { LoopSound } from './LoopSound';
import type { LoopTiming } from './LoopSound';

/**
 * 音の出口 (バス)。
 * - bgm: BGM。設定の「BGM」音量が掛かる
 * - drive: 走行系 SE (エンジン・タイヤ・路面・接触)。高音を削るフィルターを通る
 * - world: 走行中の通知 (周回・区間・DRS など)
 * - ui: メニューの操作音。ポーズ中も鳴る
 * drive / world / ui には設定の「効果音」音量が掛かり、drive / world はポーズ中に消音する
 */
export type SoundBus = 'bgm' | 'drive' | 'world' | 'ui';

/** 音 1 種類の設定 (基準音量などを 1 か所の表にまとめるための型) */
export interface SoundDef {
  /** Assets に登録した音声の名前。2 つ以上あれば鳴らすたびに (ループは作るたびに) ランダムに選ぶ */
  files: readonly string[];
  bus: SoundBus;
  /** 基準音量 (ゲイン)。素材が小さい場合は 1 を超えてもよい */
  volume: number;
  /** files ごとに基準音量へ掛ける倍率 (バリエーションの音量の差をそろえる)。省けばすべて 1 */
  fileVolumes?: readonly number[];
  /** ループの音量を下げるときにほぼ消えるまでの時間 (秒) */
  release?: number;
  /** ワンショットの再生速度に掛けるランダムな幅 (0.08 なら ±8%) */
  rateJitter?: number;
  /** ワンショットの同時発音数の上限 */
  maxVoices?: number;
  /** 同じ音を再び鳴らせるまでの最短の間隔 (秒)。既定 0.05 */
  minInterval?: number;
  /** この音だけに追加するハイシェルフ (4 kHz 以上、dB) */
  highShelfDb?: number;
  /** 音声が読めなかったときに代わりに使う音の名前 */
  fallback?: string;
}

interface BgmTrack {
  name: string;
  buffer: AudioBuffer;
  source: AudioBufferSourceNode | null;
  gain: GainNode;
  volume: number;
  /** source を start した AudioContext の時刻と、そのときの曲の位置 */
  startedAt: number;
  startOffset: number;
}

const defaultMinInterval = 0.05;
/** 設定の音量や消音の切り替えの時定数 (秒) */
const busTimeConstant = 0.02;

/**
 * Web Audio API による BGM・SE の再生。
 * AudioContext はブラウザの自動再生制限のため suspended で始まり、最初のキー入力・クリックで resume する。
 * Web Audio が使えない環境では、すべてのメソッドが何もしない。
 */
export class AudioManager {
  readonly context: AudioContext | null;

  private readonly defs = new Map<string, SoundDef>();
  private readonly buses = new Map<SoundBus, AudioNode>();
  private bgmBus: GainNode | null = null;
  private seBus: GainNode | null = null;
  /** drive / world をまとめる。ポーズ中に 0 にする */
  private worldBus: GainNode | null = null;

  private bgm: BgmTrack | null = null;
  private isBgmPaused = false;
  private paused = false;
  private hasUserGesture = false;

  private readonly lastPlayed = new Map<string, number>();
  private readonly voiceCounts = new Map<string, number>();
  private readonly warned = new Set<string>();

  constructor(private readonly assets: Assets) {
    this.context = createContext();
    if (this.context) this.buildGraph(this.context);
  }

  /** 音の設定表を登録する (名前 → SoundDef)。起動時に 1 回呼ぶ */
  defineSounds(defs: Readonly<Record<string, SoundDef>>): void {
    for (const [name, def] of Object.entries(defs)) this.defs.set(name, def);
  }

  /**
   * キー入力・クリックで AudioContext を resume し、タブが隠れたら suspend する。Game が起動時に呼ぶ
   */
  attach(target: Window): void {
    const onGesture = (): void => {
      this.hasUserGesture = true;
      this.resumeContext();
    };
    target.addEventListener('keydown', onGesture);
    target.addEventListener('pointerdown', onGesture);
    target.document.addEventListener('visibilitychange', () => {
      if (!this.context) return;
      if (target.document.hidden) void this.context.suspend().catch(() => undefined);
      else this.resumeContext();
    });
  }

  /** 設定の BGM 音量 (0〜1) */
  setBgmVolume(volume: number): void {
    this.setBusGain(this.bgmBus, volume);
  }

  /** 設定の効果音音量 (0〜1) */
  setSeVolume(volume: number): void {
    this.setBusGain(this.seBus, volume);
  }

  // ---- BGM ----

  /** 再生中の BGM の名前 (フォールバックした場合は実際に流している曲)。なければ null */
  get currentBgm(): string | null {
    return this.bgm?.name ?? null;
  }

  /**
   * BGM を切り替える。同じ曲が流れていれば何もしない (頭出ししない)。
   * 前の曲は fadeTime 秒でフェードアウトし、新しい曲は fadeTime 秒でフェードインする
   */
  playBgm(name: string, fadeTime = 0.8): void {
    const ctx = this.context;
    const resolved = this.resolve(name);
    if (!ctx || !this.bgmBus || !resolved) return;
    if (this.bgm && this.bgm.name === resolved.name) return;
    this.fadeOutBgm(fadeTime);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.bgmBus);
    this.bgm = {
      name: resolved.name,
      buffer: resolved.buffer,
      source: null,
      gain,
      volume: resolved.def.volume,
      startedAt: 0,
      startOffset: 0,
    };
    this.isBgmPaused = false;
    this.startBgmSource(this.bgm, 0);
    gain.gain.setTargetAtTime(this.bgm.volume, ctx.currentTime, Math.max(0.001, fadeTime / 3));
  }

  stopBgm(fadeTime = 0.8): void {
    this.fadeOutBgm(fadeTime);
    this.isBgmPaused = false;
  }

  // ---- ワンショット SE ----

  /**
   * ワンショットの SE を鳴らす。volume は基準音量に掛ける倍率 (衝突の強さなど)、rate は再生速度。
   * 同じ音の連打 (minInterval 以内) と同時発音数の超過は鳴らさない。鳴らしたら true
   */
  playSe(name: string, volume = 1, rate = 1): boolean {
    const ctx = this.context;
    const resolved = this.resolve(name);
    if (!ctx || !resolved) return false;
    const { def } = resolved;
    const bus = this.buses.get(def.bus);
    if (!bus) return false;
    const now = ctx.currentTime;
    // 連打の判定は呼ばれた名前で行う (フォールバック先を共有しない)
    const last = this.lastPlayed.get(name);
    if (last !== undefined && now - last < (def.minInterval ?? defaultMinInterval)) return false;
    const count = this.voiceCounts.get(name) ?? 0;
    if (def.maxVoices !== undefined && count >= def.maxVoices) return false;
    this.lastPlayed.set(name, now);
    this.voiceCounts.set(name, count + 1);

    const source = ctx.createBufferSource();
    source.buffer = resolved.buffer;
    const jitter = def.rateJitter ?? 0;
    source.playbackRate.value = rate * (1 + jitter * (Math.random() * 2 - 1));
    const gain = ctx.createGain();
    gain.gain.value = def.volume * resolved.fileVolume * Math.max(0, volume);
    source.connect(gain);
    let filter: BiquadFilterNode | null = null;
    if (def.highShelfDb) {
      filter = createHighShelf(ctx, def.highShelfDb);
      gain.connect(filter);
      filter.connect(bus);
    } else {
      gain.connect(bus);
    }
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      filter?.disconnect();
      this.voiceCounts.set(name, Math.max(0, (this.voiceCounts.get(name) ?? 1) - 1));
    };
    source.start();
    return true;
  }

  // ---- ループ SE ----

  /**
   * ループ SE を音量 0 で鳴らし始める。以後、毎フレーム loop.set(volume, rate) で変える。
   * 連番のある音 (tire-squeal-loop など) は作るたびにランダムに選ぶ。使い終わったら loop.stop()
   */
  createLoop(name: string, timing?: LoopTiming): LoopSound {
    const resolved = this.resolve(name);
    const def = resolved?.def;
    const bus = def ? (this.buses.get(def.bus) ?? null) : null;
    return new LoopSound(
      this.context,
      resolved?.buffer ?? null,
      bus,
      (def?.volume ?? 0) * (resolved?.fileVolume ?? 1),
      { release: def?.release, ...timing },
      def?.highShelfDb ?? 0,
    );
  }

  /** 自車のエンジン音 (ON / OFF のループのクロスフェード) */
  createEngine(onName: string, offName: string, options?: EngineSoundOptions): EngineSound {
    // アクセルの ON/OFF (キーボードでは 0 か 1) で音が急に切り替わらないよう、音量の追従を遅めにする
    const timing: LoopTiming = { attack: 0.04, release: 0.12 };
    return new EngineSound(this.createLoop(onName, timing), this.createLoop(offName, timing), options);
  }

  // ---- ポーズ ----

  /** ポーズ中: BGM を一時停止し、走行系・通知の SE を消音する (UI の音は鳴る) */
  pause(): void {
    const ctx = this.context;
    if (!ctx || this.paused) return;
    this.paused = true;
    this.worldBus?.gain.setTargetAtTime(0, ctx.currentTime, busTimeConstant);
    const track = this.bgm;
    if (track?.source && !this.isBgmPaused) {
      track.startOffset = this.bgmPosition(track);
      track.source.onended = null;
      track.source.stop();
      track.source.disconnect();
      track.source = null;
      this.isBgmPaused = true;
    }
  }

  /** ポーズの解除: 止めた位置から BGM を続け、SE の消音を戻す */
  resume(): void {
    const ctx = this.context;
    if (!ctx || !this.paused) return;
    this.paused = false;
    this.worldBus?.gain.setTargetAtTime(1, ctx.currentTime, busTimeConstant);
    if (this.bgm && this.isBgmPaused) {
      this.isBgmPaused = false;
      this.startBgmSource(this.bgm, this.bgm.startOffset);
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  // ---- 内部 ----

  private buildGraph(ctx: AudioContext): void {
    const master = ctx.createGain();
    master.connect(ctx.destination);
    // 同時に鳴る音が重なったときの音割れ防止 (sound-guide.md 3 章)
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -10;
    compressor.knee.value = 10;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    compressor.connect(master);

    this.bgmBus = ctx.createGain();
    this.bgmBus.connect(compressor);
    this.seBus = ctx.createGain();
    this.seBus.connect(compressor);
    this.worldBus = ctx.createGain();
    this.worldBus.connect(this.seBus);

    // 走行系の耳障りな高音を削る (sound-guide.md 4 章: 4 kHz 以上 -4 dB、10 kHz のローパス)
    const driveShelf = createHighShelf(ctx, -4);
    const driveLowpass = ctx.createBiquadFilter();
    driveLowpass.type = 'lowpass';
    driveLowpass.frequency.value = 10000;
    driveShelf.connect(driveLowpass);
    driveLowpass.connect(this.worldBus);

    this.buses.set('bgm', this.bgmBus);
    this.buses.set('drive', driveShelf);
    this.buses.set('world', this.worldBus);
    this.buses.set('ui', this.seBus);
  }

  private setBusGain(bus: GainNode | null, volume: number): void {
    if (!bus || !this.context) return;
    bus.gain.setTargetAtTime(Math.max(0, volume), this.context.currentTime, busTimeConstant);
  }

  private resumeContext(): void {
    const ctx = this.context;
    if (!ctx || !this.hasUserGesture || ctx.state === 'running') return;
    if (typeof document !== 'undefined' && document.hidden) return;
    void ctx.resume().catch(() => undefined);
  }

  /** 名前から設定と音声を引く。読めていなければ fallback をたどる。なければ一度だけ警告して null */
  private resolve(name: string): { name: string; def: SoundDef; buffer: AudioBuffer; fileVolume: number } | null {
    let current = name;
    for (let depth = 0; depth < 4; depth++) {
      const def = this.defs.get(current);
      if (!def) break;
      const picked = this.pickBuffer(def);
      if (picked) return { name: current, def, buffer: picked.buffer, fileVolume: picked.fileVolume };
      if (!def.fallback) break;
      current = def.fallback;
    }
    if (!this.warned.has(name)) {
      this.warned.add(name);
      if (!this.defs.has(name)) console.warn(`音の設定がありません: ${name}`);
      else if (this.context) console.info(`音声がないため鳴らしません: ${name}`);
    }
    return null;
  }

  private pickBuffer(def: SoundDef): { buffer: AudioBuffer; fileVolume: number } | null {
    const files = def.files;
    if (files.length === 0) return null;
    const start = Math.floor(Math.random() * files.length);
    // 選んだものが読めていなければ、読めている別のバリエーションを使う
    for (let i = 0; i < files.length; i++) {
      const index = (start + i) % files.length;
      const buffer = this.assets.getSound(files[index]);
      if (buffer) return { buffer, fileVolume: def.fileVolumes?.[index] ?? 1 };
    }
    return null;
  }

  private startBgmSource(track: BgmTrack, offset: number): void {
    const ctx = this.context;
    if (!ctx) return;
    const source = ctx.createBufferSource();
    source.buffer = track.buffer;
    source.loop = true;
    source.connect(track.gain);
    const start = offset % track.buffer.duration;
    source.start(0, start);
    track.source = source;
    track.startedAt = ctx.currentTime;
    track.startOffset = start;
  }

  private bgmPosition(track: BgmTrack): number {
    const elapsed = (this.context?.currentTime ?? 0) - track.startedAt;
    return (track.startOffset + elapsed) % track.buffer.duration;
  }

  private fadeOutBgm(fadeTime: number): void {
    const ctx = this.context;
    const track = this.bgm;
    this.bgm = null;
    if (!ctx || !track) return;
    const now = ctx.currentTime;
    const gain = track.gain;
    gain.gain.setTargetAtTime(0, now, Math.max(0.001, fadeTime / 3));
    const source = track.source;
    if (source) {
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
      };
      source.stop(now + fadeTime);
    } else {
      gain.disconnect();
    }
  }
}

function createContext(): AudioContext | null {
  try {
    return typeof AudioContext === 'undefined' ? null : new AudioContext();
  } catch (e) {
    console.warn('AudioContext を作れないため、音を鳴らしません', e);
    return null;
  }
}

function createHighShelf(ctx: BaseAudioContext, gainDb: number): BiquadFilterNode {
  const filter = ctx.createBiquadFilter();
  filter.type = 'highshelf';
  filter.frequency.value = 4000;
  filter.gain.value = gainDb;
  return filter;
}
