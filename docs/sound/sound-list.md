# サウンド一覧

方針は [sound-guide.md](sound-guide.md)。ファイルの配置先は `public/assets/sounds/bgm/` (BGM) と `public/assets/sounds/se/` (SE)、形式は OGG Vorbis。

## 優先度の基準

| 優先度 | 基準 |
| --- | --- |
| **高** | 1 人用モード (タイムアタック・CPU 車とのレース) の**最初の遊べる版**に必要。無いと操作の手応えや、レースの状況 (限界・接触・スタート・ゴール) が伝わらない |
| 中 | 最初の遊べる版に無くても遊べるが、早めに入れたい (演出・雰囲気・区別のしやすさ) |
| 低 | オンライン対戦や、演出を作り込む段階で追加する |

## 作成状況の表記

未作成 / 試作 (テスト生成・試聴済み、正式版は未作成) / 生成済み (試聴待ち) / 完成 (ユーザー試聴 OK)

バリエーション数が 2 以上のものは `-1`, `-2`, ... の連番を付ける (例: `crash-car-1.ogg`)。

## BGM (`public/assets/sounds/bgm/`)

| ファイル名 | 用途 | 長さ | ループ | バリエーション | 優先度 | 作成状況 |
| --- | --- | --- | --- | --- | --- | --- |
| race-theme.ogg | レース中 | 60〜90 秒 | あり | 1 | 高 | 生成済み (v2 オーケストラ + ロック版、試聴待ち、71.7 秒ループ) |
| menu-theme.ogg | メニュー画面 | 60〜90 秒 | あり | 1 | 中 | 生成済み (v2、試聴待ち、71.1 秒ループ) |
| qualifying-theme.ogg | 予選 (タイムアタック) | 60〜90 秒 | あり | 1 | 中 (無い間は race-theme を流用) | 生成済み (v2、試聴待ち、69.5 秒ループ) |
| result-theme.ogg | リザルト画面 | 30〜60 秒 | あり | 1 | 中 | 未作成 |
| finish-jingle.ogg | ゴール (チェッカーフラッグ) 時 | 3〜5 秒 | なし | 1 | 高 | 未作成 |
| win-jingle.ogg | 優勝・ポールポジション獲得時 (finish-jingle の代わりに鳴らす) | 4〜6 秒 | なし | 1 | 中 | 未作成 |

## SE (`public/assets/sounds/se/`)

### エンジン

| ファイル名 | 用途 | 長さ | ループ | バリエーション | 優先度 | 作成状況 |
| --- | --- | --- | --- | --- | --- | --- |
| engine-player-loop.ogg | 自車エンジン (アクセル ON)。再生速度 0.55〜1.9 で回転数を表現 | 1〜2 秒 | あり | 1 | 高 | 生成済み (試作の試聴 OK 素材を正式配置、1.5 秒ループ) |
| engine-cpu-loop.ogg | 他車エンジン。自車より細く軽い音。距離減衰・定位あり | 1〜2 秒 | あり | 1 | 中 (無い間は engine-player-loop をローパスで流用) | 未作成 |
| engine-player-decel-loop.ogg | 自車エンジン (アクセル OFF・減速時のこもった音)。ON 用とクロスフェード | 1〜2 秒 | あり | 1 | 中 | 生成済み (試聴待ち、2.0 秒ループ) |
| engine-rev.ogg | スタート前のグリッドでの空ぶかし | 1〜2 秒 | なし | 2 | 低 | 未作成 |
| gear-shift.ogg | シフトアップ時の短い「パン」という音 | 0.2〜0.4 秒 | なし | 2 | 低 | 未作成 |
| pit-limiter-beep.ogg | ピットレーンの速度制限中の断続音 (ピットリミッター) | 0.5〜1 秒 | あり | 1 | 低 | 未作成 |

### タイヤ・路面

| ファイル名 | 用途 | 長さ | ループ | バリエーション | 優先度 | 作成状況 |
| --- | --- | --- | --- | --- | --- | --- |
| tire-squeal-loop.ogg | グリップ限界の通知。スリップ率で音量・再生速度を連続的に変える | 1.5〜3 秒 | あり | 2 | 高 | 生成済み (試聴待ち、-1: 3.15 秒 / -2: 1.9 秒ループ) |
| tire-lockup.ogg | 急ブレーキでタイヤがロックしたとき | 0.5〜1 秒 | なし | 2 | 中 | 生成済み (試聴待ち、-1: 0.37 秒 / -2: 0.42 秒。目安 0.5〜1 秒より短い) |
| offtrack-grass-loop.ogg | 芝生を走っている間。速度で音量・再生速度を変える | 1.5〜3 秒 | あり | 1 | 高 | 生成済み (試聴待ち、2.5 秒ループ) |
| offtrack-gravel-loop.ogg | 砂利 (グラベル) を走っている間 | 1.5〜3 秒 | あり | 1 | 高 | 生成済み (試聴待ち、2.5 秒ループ) |
| kerb-rumble-loop.ogg | 縁石に乗っている間のガタガタ音 | 1〜2 秒 | あり | 1 | 中 | 生成済み (試聴待ち、2.0 秒ループ) |

### 接触

| ファイル名 | 用途 | 長さ | ループ | バリエーション | 優先度 | 作成状況 |
| --- | --- | --- | --- | --- | --- | --- |
| crash-car.ogg | 車同士の接触 (火花)。強さで音量を変える | 0.3〜1 秒 | なし | 3 | 高 | 試作 (衝突音 1 種で試聴 OK) |
| crash-wall.ogg | 壁・バリアへの衝突 | 0.5〜1 秒 | なし | 3 | 高 | 生成済み (試聴待ち、3 種 0.6〜0.7 秒) |
| scrape-loop.ogg | 壁や他車と擦れ続けている間 (火花が出続ける) | 1〜2 秒 | あり | 1 | 中 | 生成済み (試聴待ち、2.0 秒ループ) |
| tire-barrier-hit.ogg | タイヤバリアへの柔らかい衝突 | 0.5〜1 秒 | なし | 2 | 低 | 生成済み (試聴待ち、-1: 0.41 秒 / -2: 0.70 秒) |

### スリップストリーム・DRS

| ファイル名 | 用途 | 長さ | ループ | バリエーション | 優先度 | 作成状況 |
| --- | --- | --- | --- | --- | --- | --- |
| drs-open.ogg | DRS 作動 (リアウイングが開く機械音 + 短い電子音) | 0.3〜0.6 秒 | なし | 1 | 高 | 生成済み (試聴待ち、0.34 秒) |
| drs-close.ogg | DRS 解除 (ブレーキ・区間終了) | 0.3〜0.5 秒 | なし | 1 | 中 | 生成済み (試聴待ち、0.17 秒。目安 0.3〜0.5 秒より短い) |
| drs-available.ogg | DRS 使用可能になった通知 (検知ポイント通過) | 0.3〜0.6 秒 | なし | 1 | 中 | 未作成 |
| slipstream-wind-loop.ogg | 前車の真後ろで吸い込まれている間の風切り音 | 2〜3 秒 | あり | 1 | 中 | 未作成 |

### スタートシグナル・レース進行 (F1 中継風の演出)

| ファイル名 | 用途 | 長さ | ループ | バリエーション | 優先度 | 作成状況 |
| --- | --- | --- | --- | --- | --- | --- |
| start-light-on.ogg | 赤ランプが 1 灯点くたびに鳴る (5 回) | 0.2〜0.4 秒 | なし | 1 | 高 | 未作成 |
| start-go.ogg | 全消灯 (スタート) の合図 | 0.4〜0.8 秒 | なし | 1 | 高 | 未作成 |
| false-start.ogg | フライング (ジャンプスタート) の警告 | 0.5〜1 秒 | なし | 1 | 低 | 未作成 |
| lap-complete.ogg | コントロールライン通過 (周回の完了) | 0.3〜0.6 秒 | なし | 1 | 中 | 生成済み (試聴待ち、0.38 秒) |
| final-lap.ogg | ファイナルラップ突入の通知 | 0.8〜1.5 秒 | なし | 1 | 中 | 未作成 |
| sector-time.ogg | 区間タイム表示 (通常) | 0.2〜0.4 秒 | なし | 1 | 中 | 生成済み (試聴待ち、0.27 秒) |
| sector-best.ogg | 区間タイム・ラップタイムの自己ベスト / 全体ベスト更新 | 0.4〜0.8 秒 | なし | 1 | 中 | 生成済み (試聴待ち、0.42 秒) |
| position-change.ogg | 順位表の順位が入れ替わったとき | 0.2〜0.4 秒 | なし | 1 | 低 | 未作成 |
| qualifying-countdown.ogg | 予選セッション残り時間の警告音 | 0.2〜0.4 秒 | なし | 1 | 低 | 未作成 |

### ピット

ピットインを最初の遊べる版に入れる場合は、pit-wheelgun を「高」に上げる。

| ファイル名 | 用途 | 長さ | ループ | バリエーション | 優先度 | 作成状況 |
| --- | --- | --- | --- | --- | --- | --- |
| pit-wheelgun.ogg | タイヤ交換のインパクトレンチ (4 輪ぶん少しずつずらして鳴らす) | 0.4〜0.8 秒 | なし | 2 | 中 | 未作成 |
| pit-jack.ogg | ジャッキで車を持ち上げる / 下ろす | 0.3〜0.6 秒 | なし | 1 | 低 | 未作成 |
| pit-release.ogg | ピット作業完了・発進の合図 | 0.3〜0.6 秒 | なし | 1 | 低 | 未作成 |

### UI 操作音

| ファイル名 | 用途 | 長さ | ループ | バリエーション | 優先度 | 作成状況 |
| --- | --- | --- | --- | --- | --- | --- |
| ui-cursor.ogg | メニューのカーソル移動 | 0.05〜0.15 秒 | なし | 1 | 高 | 生成済み (試聴待ち、0.07 秒) |
| ui-confirm.ogg | 決定 | 0.15〜0.4 秒 | なし | 1 | 高 | 生成済み (試聴待ち、0.23 秒) |
| ui-cancel.ogg | 戻る・キャンセル | 0.15〜0.3 秒 | なし | 1 | 中 | 生成済み (試聴待ち、0.22 秒) |
| ui-pause.ogg | ポーズ / ポーズ解除 | 0.2〜0.4 秒 | なし | 1 | 中 | 生成済み (試聴待ち、0.17 秒) |
| ui-error.ogg | 選べない項目を選んだとき・接続失敗 | 0.2〜0.4 秒 | なし | 1 | 低 | 生成済み (試聴待ち、0.37 秒) |

### オンライン対戦

| ファイル名 | 用途 | 長さ | ループ | バリエーション | 優先度 | 作成状況 |
| --- | --- | --- | --- | --- | --- | --- |
| lobby-join.ogg | ロビーにプレイヤーが参加 | 0.2〜0.5 秒 | なし | 1 | 低 | 未作成 |
| lobby-leave.ogg | ロビーからプレイヤーが退出・切断 | 0.2〜0.5 秒 | なし | 1 | 低 | 未作成 |
| lobby-ready.ogg | 全員準備完了 | 0.3〜0.6 秒 | なし | 1 | 低 | 未作成 |

## 優先度「高」のまとめ

| ファイル | 本数 |
| --- | --- |
| race-theme, finish-jingle | BGM 2 本 |
| engine-player-loop, tire-squeal-loop (×2), offtrack-grass-loop, offtrack-gravel-loop, crash-car (×3), crash-wall (×3), drs-open, start-light-on, start-go, ui-cursor, ui-confirm | SE 16 本 (12 種) |

## 試作 (テスト生成) の記録

| 素材 | モデル | プロンプト | 結果 |
| --- | --- | --- | --- |
| レース BGM | ACE-Step | `chiptune, synthwave, racing game, fast tempo, 150 bpm, energetic, driving bassline, arpeggio` (30 秒、seed 7) | 試聴 OK。正式版は 60〜90 秒で生成し直す |
| エンジンループ | Stable Audio Open | `formula one race car engine idling at steady high rpm, continuous mechanical hum, no gear change` (3 秒生成、seed 11) → `--loop --crossfade 0.5` で 1.5 秒ループ | 試聴 OK |
| タイヤスキール | Stable Audio Open | `car tires screeching on asphalt, short skid` (2 秒、seed 11) | 試聴 OK。ゲームではループ版にする |
| 衝突音 | Stable Audio Open | `two race cars colliding, metal impact thud, short` (2 秒、seed 11) | 試聴 OK。ラウドネスは -26 LUFS 程度 (ピーク制限のため) |

試作の元音声は `assets-src/generated/sound/test-*.flac`、変換後は `assets-src/test/sound/test-*.ogg` にある (どちらも git 管理外。`public/assets/` には置いていない)。正式版を配置したら削除してよい。

## 正式版の生成記録 (2026-09-25、M1 分)

元音声は `assets-src/generated/sound/<name>-<seed>-<番号>.flac`。SE のプロンプトの先頭には `sound effect, isolated, clean recording,` が、BGM には `instrumental, video game music,` が自動で付く。
共通ネガティブ (SE): `reverb, echo, crowd, ambience, background noise, wind`。ループ素材は `acceleration, revving, doppler, pass by, fade`、走行系は `harsh, piercing, high-pitched whine, screeching feedback` も追加。

| ファイル | 元音声 (seed-番号) | プロンプト (要約) | 加工 |
| --- | --- | --- | --- |
| race-theme (v2) | race-theme-v2-641000237-3 | 共通タグ (下記) + `fast tempo, 150 bpm, energetic, driving, adrenaline, bright brass stabs, clean mix, light low mids` (100 秒) | 350 Hz 付近を -3 dB (エンジン音の帯域を空ける) のあと 16〜89.7 秒、71.7 秒ループ |
| menu-theme (v2) | menu-theme-v2-934448438-3 | 共通タグ + `120 bpm, majestic, triumphant, grand, broad brass theme, steady pulse, warm, clean mix` | 16〜89.1 秒、71.1 秒ループ |
| qualifying-theme (v2) | qualifying-theme-v2-1092852604-3 | 共通タグ + `135 bpm, tense, suspenseful, focused, restrained, low staccato strings, ticking synth pulse, light drums, building tension, clean mix` | 16〜87.5 秒、69.5 秒ループ |
| engine-player-loop | test-engine-loop-11 | 試作と同じ | `--loop --crossfade 0.5` |
| engine-player-decel-loop | engine-player-decel-loop-490632532-2 | `formula racing car engine at steady mid rpm with throttle off, engine braking, muffled low burble with light crackles, steady ...` | 1〜3.5 秒、crossfade 0.5 |
| tire-squeal-loop-1 / -2 | tire-squeal-loop-3374578360-3 / -2 | `race car tires squealing continuously on asphalt during a long sustained cornering slide, steady ...` | -1: 2.25〜5.9 秒 / -2: 1.4〜3.7 秒 |
| offtrack-grass-loop | offtrack-grass-loop-875526784-3 | `car tires rolling fast over grass and soft dirt, continuous rumbling and swishing of grass ...` | 120 Hz ハイパス + リミッター (瞬間的な打音を抑えて平均音量を揃える) のあと 1〜4 秒 |
| offtrack-gravel-loop | offtrack-gravel-loop-3103962877-2 | `car tires driving fast through loose gravel trap, continuous crunching and stones scattering ...` | 100 Hz ハイパス + リミッターのあと 1〜4 秒 |
| kerb-rumble-loop | kerb-rumble-loop-2034137185-3 | `car tires rolling fast over a rumble strip kerb, rapid rhythmic rattling vibration ...` | 1〜3.5 秒 |
| scrape-loop | scrape-loop-3353774419-3 | `metal car body scraping continuously along a concrete wall, grinding friction ...` | 0.5〜2.9 秒、crossfade 0.4 |
| crash-wall-1〜3 | crash-wall-428674958-1 / -3 / -5 | `race car crashing hard into a concrete wall barrier, heavy metal impact crunch, single, short` | 先頭 1 秒を切り出し指数フェード |
| drs-open / drs-close | drs-open-1799627946-2 / drs-close-2152792247-2 + ui-pause の電子音 | `quick mechanical rear wing flap opening/closing, pneumatic actuator ...` | 機械音に短い電子音 (ui-pause 候補 3 / 2 の頭) を -15 dB で重ねた |
| ui-cursor / ui-confirm / ui-cancel / ui-pause | ui-cursor-3602680816-3 / ui-confirm-2465593198-1 / ui-cancel-640208055-4 / ui-pause-2556034712-4 | `retro 8-bit video game menu ... square wave` | 頭の音だけ切り出し |
| lap-complete / sector-time / sector-best | lap-complete-3119191679-1 / sector-time-4129768023-1 / sector-best-2724617714-3 | `retro 8-bit video game checkpoint chime` / `notification blip` / `high score chime, rising arpeggio` | 頭の音だけ切り出し |
| tire-barrier-hit-1 / -2 | tire-barrier-hit-4176508299-3 / -1 | `race car bumping into a stack of rubber tires, soft dull thud with a rubbery bounce, light impact, single, short ...` | 先頭 0.8 秒、直線フェード |
| tire-lockup-1 / -2 | tire-lockup-3580956293-4 / -5 | `car tires locking up under hard braking on asphalt, short sharp chirp skid, single, short ... muffled high frequencies` | 7 kHz ローパスのあと先頭 0.6 秒、直線フェード |
| ui-error | ui-error-1642429084-2 | `retro 8-bit video game error buzzer, short low dissonant square wave double buzz, clean` | 頭のブザー 0.16 秒を 50 ms あけて 2 回つなげた |

- 短いワンショット (0.4 秒未満) は LUFS を測れないため、RMS -15 dB (ピーク -1.5 dBFS 以下) に揃えた。drs-open/close はピーク制限で RMS -23〜-26 dB
- BGM v2 の共通タグ: `cinematic orchestral rock, heroic brass, fast staccato string ostinato, powerful rock drums, pulsing synth bass, sports broadcast opening theme, uplifting` (実在の番組名・作曲者名は入れていない)
- BGM の別候補は `assets-src/candidates/bgm/*-v2-alt.ogg`。旧版 (チップチューン + シンセウェーブ) は `*-v1-synthwave*.ogg` に退避 (旧版の元音声: race-theme-2833509042-2、qualifying-theme-1900216363-1、menu-theme-1233609196-2)
