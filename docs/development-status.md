# 実装と検証の記録

2026-09-20。`fill-fields.v1` の初期実装を追加した。初期公開 main は `58eba4b`、作業ブランチは `codex/implement-runtime`。初期実装から読み取り予算の拡張までを `cdf31bfc725510f9096e2aa2bbc8b0b65784e614` として push し、[hosted CI](https://github.com/annenpolka/ariadne/actions/runs/35489539694) の成功と remote ref の一致を確認した。以下の実機試験はローカルで実行した結果であり、hosted CI の対象とは分ける。

独立 Chrome profile の追加試験と修正は [browser-status.md](browser-status.md)。この段階では Chrome はローカル合成フォーム限定で、実 AX 入力と遷移時の拒否を確認した。

当初の Calendar 専用読み取り（[旧記録](calendar-status.md)）は、Task 不要の `ariadne.chrome` 観測セッションに置き換えた。通常テスト109件、Swift 単体4件、実 Chrome 読み取り15項目と既存 AX／入力回帰を確認する構成。この段階の実行証拠と初回失敗・修正は [browser-read-status.md](browser-read-status.md) に記録した。これは P3 の読み取り基盤の追加であり、一般サイトへの入力・遷移や P4 の汎用 Planner の完成を意味しない。

続く `project-ax-text.v1` の追加で、通常テストは135件。サイトに依存しない name/value の証拠付き引用を実装し、意味的な項目抽出とは区別した。[読み取り Task の記録](browser-extract-status.md)を参照。

読み取り予算の再見積もりと、通信・抽出処理の拡張は [browser-budget-sizing.md](browser-budget-sizing.md)に記録した。以前の測定で partial だった MDN と RFC 9110、合成3万ノードを、拡大した既定予算で省略なく取得した。明示最大値で65,536ノードも確認済み。この段階のコードで通常138件・Swift単体8件・実 Chrome読取15項目／抽出7項目・Native AX操作fixture11シナリオが成功し、Calendarも592ノード属性レコードを予算による打ち切りなく読めた。予定の意味的な抽出や仮想化された未表示部分の全件取得を示すものではない。

共通の `browser act` を追加し、operator が固定した手順の入力・press と再開を実装した。通常142件、Swift13件、実 Chrome操作9項目・読み取り15項目・抽出7項目、既存 Native fixture11シナリオと Chrome入力fixtureが成功。実 Calendar でも許可された予定を保存し、一覧と開き直した編集画面で確認した。Codex が対象選択と画面遷移を判断しており、Ariadne 単体の目標 Planner の検証ではない。詳細と証拠は [browser-action-status.md](browser-action-status.md)。

## 実装した範囲

TypeScript strict の Core、fake Host、Swift AX Host、stdio RPC client、Jev provider、CLI を接続した。Task と成功条件を固定し、grant の Read/Model/Act を検査する。Host は prepare 済みの内容だけを commit し、dispatch intent と結果を永続化する。結果不明の操作は再起動後も scope の変更を止め、照会・引継ぎへ進む。

Core の Task と累積予算は JSON、Host の journal は JSONL。Node 側の排他制御には SQLite のトランザクションロックを使い、強制終了したプロセスのロックを OS が解放する。PID ファイルの削除による所有権の奪取は行わない。Swift 側は保持したファイルの `flock` を使う。

CLI は `observe`、`preview`、`execute`、`resume`、`replay`、`reevaluate`。既定の trace は metadata、入力値・画面値を残す replayable trace は明示フラグを要する。exact replay は記録済みの制御経路を再生する。reevaluate は記録済みの観測をモデルへ再送するが、Host を起動しない。利用手順は [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 初期実装時点の実行結果

| 経路 | 確認結果 | ローカル証拠・再実行 |
|---|---|---|
| 型・通常テスト | strict typecheck、95/95 成功 | `.runtime/tests-final-stable.txt`、`npm run typecheck && npm test` |
| TypeScript build・CLI | build、demo、observe、preview、resume、exact replay 成功 | `.runtime/cli-final-1789866690295/`。preview は `completed_unverified` / `preview_ready`、実行成功とは区別 |
| CLI reevaluate | 実 Jev による比較1件、GUI 操作なし | 同ディレクトリの `reevaluate/` |
| JSON 契約 | 正例6件・負例22件成功、生成物に差分なし | `make generate` の後に `make check`。テストと生成は同時実行しない |
| Swift build | Host・fixture・probe の build 成功 | `swift build --package-path native --scratch-path .cache/swift` |
| 実 AX | 専用 fixture の11シナリオ成功 | `.runtime/native-acceptance-7d6d6478-cb21-4872-b26b-655a87d13866/report.json` |
| 実 Jev → Core → 実 AX | 1リクエスト、2欄入力、独立 oracle と一致、AX setter 2回、Submit 0回 | `.runtime/native-jev-1789866556420/`、`npm run test:native-model` |
| TextEdit | 新規合成文書を観測し、条件不足で操作を拒否 | `.runtime/textedit-1789865452465/`、下記の対応限界 |

実 AX の11件は通常入力、intent 後のクラッシュ、dispatch 後のクラッシュ、応答喪失、journal 失敗、登録済み invoke、要素交換、モーダル、cancel、遅延中 cancel 競合、disabled。クラッシュは実 Host プロセスを終了させ、再起動後の unknown と新しい操作 ID の拒否を確認した。応答喪失後の再照会・重複 commit は setter を増やさない。invoke の5重送信でも独立 oracle の Submit は1回だった。

cancel 競合では、耐久 intent 記録後の実 AX getter を800ms遅延させ、到達 marker を確認してから cancel を送った。control 側は400ms未満で応答し、未実行 setter は0回、結果は unknown になった。cancel 前に届いていた `session.open` も後から停止を解除しない。fixture の setter は計数と値の同期を明示実装しているため、一般アプリの setter 動作を保証する証拠にはしない。

## README 第15節との対応

| 必須シナリオ | 実行した検証 |
|---|---|
| 同名欄と所属 | 合成固定評価、実 AX 上の Jev で連絡先・配送通知先を区別 |
| 初回観測の外 | 固定評価 seed 216 の partial → 追加観測 |
| 準備後の要素交換 | fake Host と実 AX replacement が旧操作を拒否 |
| 古い model 応答 | revision 不一致、cancel 後の遅延応答を通常テストで拒否 |
| operationId 再送 | fake Host、実 AX の setter / Submit 計数 |
| dispatch 前後のクラッシュ | fake journal と実 AX の再起動・unknown fence |
| cancel と dispatch の競合 | fake queue と実 AX の遅延 getter |
| 値取得失敗 | unavailable を空文字・上書き可能状態として扱わない通常テスト |
| 正しい値だが対象が違う | 意図的な誤 Binding は機械的 readback に成功しても独立 oracle が拒否 |
| モデルだけの完了 | `done` の追加だけでは固定 checks を満たさない通常テスト |
| 無関係な時計表示 | 時計が変化しても同じ失敗を2回で止め、dispatch 0回 |
| アプリ内容による権限拡張 | アプリ文字列・provider 内の変更が固定 grant / Task を拡張しない通常テスト |

これらは試験境界ごとの証拠である。prompt injection 全般の耐性、誤った意味 Binding を必ず自動検知できること、全ての native 通知の配信は証明していない。特に `verified_success` と semantic assurance は、選ばれた対象で固定値検査が通ったことを表す。意味対象そのものの正しさは独立 oracle の評価と区別する。

## Jev 実呼出しと固定評価

公式 SDK `@typesafe-ai/sdk` を使い、返却モデル `jev-1.13.0` を確認した。現在の質問セットは `binding-v2`。入力値・現在値・oracle を質問 state へ渡さず、意味・所属・候補名・属性取得状態を渡す。

calibration 6件と heldout 7件を分離し、両方の並び順、3表記、exact / 自然文の依頼、初回観測欠落を固定 seed で比較した。最新実行は29リクエスト（calibration 6、each_step 15、batch 8）。

| 方策 | heldout oracle 成功 | heldout 意味判断数 | 全試行の所要時間中央値 | 意味判断時間中央値 |
|---|---:|---:|---:|---:|
| exact label | 3/7 | 0 | 23ms | 0ms |
| 各ステップ判断 | 7/7 | 15 | 694ms | 546ms |
| 一括 Binding | 7/7 | 8 | 419ms | 293ms |

この集合の誤対象・誤成功は0件。所要時間は fake Host で Core の開始から完了までを測り、失敗した試行も含む。実 GUI の速度比較ではない。モデル時間は SDK 呼出しと応答処理を含み、自動 API 再試行は無効。観測・prepare・dispatch・検証は総時間に含むが、それぞれの独立した時間内訳は未計測。

証拠は `.runtime/jev-eval-1789866191948/protocol.json`、`results.json`、各 `exchange-*.json`。しきい値 probability 0.8、margin 0.2、abstention 0.1 は事前固定。`config/calibration.synthetic-forms-v2.json` は fixture 限定の初期設定で、一般 GUI の成功率や実アプリ向け校正を証明しない。

初回の24リクエストは seed が奇数の素数だけで、順序・一部表記の網羅が不足していた（`.runtime/jev-eval-1789864814116/`）。修正した集合の binding-v1 結果は `.runtime/jev-eval-1789864913426/` に残した。祖先名の取得状態を保持する binding-v2 へ更新した後、同じ修正済み集合と実 AX 統合を再実行した。

## TextEdit と未確認の範囲

TextEdit profile は operator が指定する PID、window、絶対文書パス、bundle identity と native capability を検査する。実際に新しい合成文書を開いたところ、本文は `AXTextArea`、value は available、`set_value` capability はあり、enabled は unsupported だった。必須の有効状態を確かめられないため Core は blocked にして変更しなかった。TextEdit の入力・読み戻し成功とは報告しない。既存の利用者文書を試験には使っていない。

- 外部 GUI の compare/read/act 間の競合と、全ての人間入力の検知は解決していない。通知はヒントとして扱い、鮮度判定には再読を使う。
- native の初期観測で eventSeq 0/0 も観測したが、通知欠落の全パターン、権限を途中で剥奪する試験、全アプリ適合は未実施。
- 無進捗の抑止は slot ごとの stale_binding 回数を使う保守的な初版。関連状態の進展を精密に識別する汎用 fingerprint ではなく、連続した正当な画面変化でも停止し得る。
- 電源断・ストレージ障害全般、外部 GUI との原子的トランザクション、exactly-once は証明していない。
- replay は完了した記録の同じ制御経路が対象。任意のタイミング競合や反実仮想操作は再現しない。
- `.github/workflows/check.yml` と opt-in の `ax.yml` を追加した。hosted CI は未実行。AX ジョブには専用のログイン済み self-hosted Mac が必要。配布署名・権限維持は未対応。

## DS 委譲と親の受入

使用スキルは [opencode-delegate](https://github.com/annenpolka/skills/tree/main/opencode-delegate)。全呼出しのモデルは指定どおり `opencode-go/deepseek-v4.1-flash`。Native session は `ses_f43e0eb65ffeJR5ZihjqwbnnOb`、Core session は `ses_f43de46d2ffeNIeb2CP9kCA0eV`。未プッシュコードの送信はユーザーが明示許可し、認証情報・.env・raw trace・他プロジェクトを除外した。

relay status は failed のまま保存した。transport ECONNRESET、finish_reason 欠落、終了 step 欠落があり、正常完了レシートとは扱わない。受け取った変更は親がレビューし、反例を修正して上記の経路を実行した。Core の復旧、Swift の stdio EOF 待ち、祖先順序、root ref、モーダル検出、fsync エラー伝播、cancel 世代管理などは親の修正を含む。lease 消失を無視する修正は採らず、テスト cleanup を修正して消失をエラーに戻した。

記録は `.runtime/delegation/` の `p0-core-recovery/`、`p0-core-review/`、`p1-native-host/`、`p1-native-repair/`、`p1-p3-profiles/`。

## Jev Crosscheck の読解補助

使用スキルは [jev-crosscheck](https://github.com/annenpolka/skills/tree/main/jev-crosscheck)。各 helper exit 0、返却モデル `jev-1.13.0`。確率を PASS/FAIL や実行証拠に置き換えない。以下の request と response は `.runtime/jev/` に対で保存した。

| 記録名 | 送信した state と出典 |
|---|---|
| `host-brief` / `native-brief` | `brief`、`spec`。委任の範囲と関連仕様 |
| `native-review` | 許可した `Journal.swift:1-260`、`AX.swift:220-360`、`Host.swift:130-175` / `245-335` の当時のソース断片 |
| `runtime-review` | `runtime`、`locking`、`trace`、`types` は対応する src ファイル。`compiler` は Jev の純粋変換部分。`test_code` は Core 回帰・trace 試験、`test_contracts` はその検査意図 |
| `clock-review` | `host_fixture`、`clock_test`、`recovery` は試験 Host・時計回帰・Core recover のソース。`helpers`、`observation`、`task` は合成 fixture、`contract` は検査意図 |
| `compiler-v2-review` | `compiler`、`ancestors` は該当関数。`tests`、`test_helpers`、`task_example`、`observation_example` は合成試験と生成例。`contract` は秘匿と取得状態保持の検査意図 |

意味のある回答と親の判断は次のとおり。数値は Noul の `noul` であり confidence ではない。

- native `stable_refs` 0.30、`origin_semantics` 0.22 は同一 native 要素の ref 維持と元観測の意味属性比較への疑義。source `capture_source` 0.96、`prepare_source` 0.88。親の読解でも反例を見つけ、修正後は実 AX の再観測・要素交換で確認した（counterexample found by reading → confirmed by execution）。
- native `durability_errors` 0.63、`directory_errors` 0.91 は fsync / directory sync の失敗伝播を肯定したが、当時のコードはエラーを捨てていた。`journal_source` 0.96 でも反例は消えない。親が直接読解で修正した。状態は修正箇所について confirmed by reading、電源断耐久性は unresolved。
- native `observable_unknown` 0.10。元 openSession は unknown 下の観測も拒否していた。read と mutation の fence を分け、再起動→open→capture→新 ID 拒否を実 AX で確認した（confirmed by execution）。
- brief `crash_recovery` 0.67、具体的記述の source 0.96。設計文を受入証拠にせず、実プロセスの障害注入を実施した。
- runtime `resume_identity` 0.93、`lease_authority` 0.95、`metadata_values` 0.90、`kernel_release` 0.97。各々、再開時 receipt ID、lease のない cancel 抑止、metadata の生値除外、OS lock の解放を指す。source は runtime 0.93、trace 0.97、locking 0.90。直接読解と回帰試験で確認した（confirmed by execution）。
- 同じ runtime バッチの `compiler_values` 0.96、`receipt_test` 0.83、`trace_test` 0.92 に対し、`compiler_source` 0.69、`tests_source` 0.66 と材料の十分さが弱かった。高い主張回答だけで支持とは扱わず、コンパイラの補助関数・例・試験を追加して別バッチを送った。receipt / trace の受入は実行した回帰試験に基づく。
- compiler-v2 `compiler_values` 0.94、`privacy_test` 0.84、`status_test` 0.89。source は `compiler_source` 0.94、`fixtures_source` 0.90、`assertions_source` 0.85。現在値の sentinel 除外と unsupported 属性の保持を試験した（confirmed by execution）。
- compiler-v2 `ancestor_status` 0.47 は取得状態保持を強く支持しなかった。親が読み直すと、祖先列の補助関数は名前を空文字にするが、コンパイラは ref で元ノードを引き直して name 属性全体を使用する。unsupported を期待する回帰試験も成功したため、現コンパイラの保持は confirmed by reading / execution とした。

- clock `clock_changes` 0.94、`recovery_key` 0.96、source は `fixture_source` 0.90 / `recovery_source` 0.94。一方 `regression_boundary`（時計変化を理由とした2回超の再試行を拒否する試験か）は0.52だった。親は prepare カウンタの明示的な `assert.equal(..., 2)` と、変化する時計を含む実行結果を確認した。状態は confirmed by reading / execution。

SDK の参照: [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)、[Choice](https://docs.typesafe.ai/primitives/choice)、[Function calling](https://docs.typesafe.ai/cookbooks/function_calling)。実測値はこれらの文書ではなく、上記の自前実行記録に基づく。
