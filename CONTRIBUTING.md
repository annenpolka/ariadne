# 開発と実行

作業前に README、次に構想の履歴 `Jev-Cu解説.md`、現在の証拠 `docs/development-status.md` を読む。実行時の合否と設計上の約束を区別する。

## Node.js と通常テスト

Node.js 24 系を使う。`.node-version` は24.18.0。既定 PATH が別のメジャーなら mise 等で切り替える。macOS のこの作業では `/Users/annenpolka/.local/share/mise/installs/node/24.18.0/bin` を使用した。

```sh
node --version
npm ci
npm run typecheck
npm test
npm run build
npm run demo
```

通常テストはネットワークも GUI も使わない。fake Host、状態機械、実ファイルの永続記録、別プロセスとの通信、強制終了後のロック解放を検査する。`src/locking.ts` は Node 標準の SQLite 接続で OS 管理の排他ロックを保持し、PID ファイルを削除して所有権を奪わない。Task 本体の保存形式は JSON、dispatch journal は JSONL のまま。

## CLI

`npm run cli -- --help`、または build 後の `node dist/src/cli.js --help`。

```sh
npm run cli -- demo --state-dir .runtime/my-demo --record-replay --trace .runtime/my-demo/replayable.json
npm run cli -- preview --task .runtime/my-demo/task.json --grant .runtime/my-demo/grant.json --state-dir .runtime/preview
npm run cli -- resume --task .runtime/my-demo/task.json --grant .runtime/my-demo/grant.json --state-dir .runtime/my-demo
npm run cli -- replay --trace .runtime/my-demo/replayable.json --grant .runtime/my-demo/grant.json --state-dir .runtime/replay
```

`observe` は scope 内の生の観測を標準出力へ返す。`preview` は Binding を返して操作しない。`execute` と明示的 `resume` は固定 Task・grant を読み、残り予算を引き継ぐ。Task 内容を変えるなら revision を上げる。結果不明の scope は revision や操作 ID を変えても操作できない。

既定の trace は metadata。`--record-replay` は入力値と画面属性の保存を明示的に有効化する。ファイルは0600で保存し、`.runtime/` をコミットしない。exact replay は記録済みの観測と判断を使う制御経路の再生であり、外部 GUI・モデルを動かさない。異なる操作の世界や、任意のタイミング競合は再現しない。途中で未完了の呼出しがある記録は再生用として保存できない。

`reevaluate --trace FILE --grant FILE --model jev-1.13.0 --keychain` は replayable trace の Binding 入力を新しくモデル評価する。Read/Model grant が必要で、GUI 操作はしない。比較結果は新しい state-dir に保存する。

## Swift と実 AX

macOS、Swift 6、ログイン中のデスクトップ、実行元の Accessibility 権限が必要。権限を自動変更しない。

```sh
swift build --package-path native --scratch-path .cache/swift
npm run test:native
```

試験は専用 `AriadneFixture` だけを起動し、終了時に自分で起動したプロセスを停止する。oracle の場所・値・setter回数は Host/model の観測に含めない。通常入力、実プロセスのクラッシュ、応答喪失、登録済みボタン、要素交換、モーダル、cancel 競合を別々の state-dir で試す。fixture の accessibility setter は計数と本文値の同期を明示実装している。これを一般アプリの編集動作への保証にしない。

Native CLI は `--host macos --pid PID --window-title EXACT_TITLE --host-binary .cache/swift/debug/AriadneHost` を指定する。grant は operator 側の設定ファイルで、Task やモデルから発行しない。fixture の invoke は `allowedCommands:["invoke"]` だけでは許可されず、`allowedActions` に `fixture.submit`、`fixture.replace_field`、`fixture.show_modal` の必要な操作を列挙する。

TextEdit は `--document /absolute/scratch.txt --provider profile` も必要。Host が app bundle、文書パス、window/native identity と直接 AX capability を検査する。`npm run test:textedit` は新しい合成文書だけを作って開く。文書は検査用に残す。現環境では本文の AXEnabled が unsupported なので変更を止める。キー入力や座標操作への代替はない。アプリによる autosave の有無を Host が制御できるとは主張しない。

## 独立 Chrome プロファイル

macOS の `/Applications/Google Chrome.app` と、上記の Swift build を使う。

```sh
npm run test:browser
# 通常の Chrome ウィンドウで入力し、確認用に画面を残す
npm run test:browser -- --demo
```

試験ごとに `.runtime/browser-*/profile/` を新規作成し、`--user-data-dir` で独立した Chrome プロセスを起動する。既存のログイン・Cookie・拡張機能をコピーしない。専用 localhost サーバーが合成フォームを提供し、Host が AX で2欄に入力する。ページ側の値も独立に照合し、無効欄・パスワード欄・URL 変更後の操作拒否を確認する。終了時に専用ブラウザとサーバーを停止し、プロファイルと記録をローカルに残す。

この試験は exact label provider を使う。ブラウザの画面・入力値をモデルへ送る試験ではない。Host の登録名は `ariadne.chrome_fixture`、CLI では `--host macos --pid PID --window-title EXACT_TITLE --page-url http://127.0.0.1:PORT/path` と対応する operator grant を指定する。URL はポート付き loopback HTTP の完全一致に限定し、query・fragment・認証情報を拒否する。実行中も window の AXDocument、WebArea の URL と native identity を確認する。一般サイトへの入力や browser invoke は未対応。読み取り専用の共通 profile は次節を参照。

`--demo` は新しい通常ウィンドウで2欄の入力・読み戻しまで実行し、操作 Host を閉じて画面を残す。URL を変更する拒否試験はこのモードでは行わない。専用 Chrome を終了するとローカルサーバーも終了する。

実行結果と Chrome 固有の修正は [browser-status.md](docs/browser-status.md) を参照。

## 汎用ブラウザの読み取り

Swift build 後、サイトの URL と許可する origin を指定する。

```sh
npm run browser -- open https://example.org/
npm run browser -- status .runtime/browser-session-XXXXXX --origin https://example.org
npm run browser -- read .runtime/browser-session-XXXXXX --origin https://example.org
# 生の観測を明示的に表示・保存する場合
npm run browser -- read .runtime/browser-session-XXXXXX --origin https://example.org --raw --record
npm run test:browser-read
swift test --package-path native --scratch-path .cache/swift
```

`open` は毎回独立 profile の Chrome を開き、ウィンドウを残す。既存の Cookie はコピーしない。認証が必要なページではそのウィンドウでログインし、目的の origin に戻ってから読む。以前の Calendar 専用 CLI で作成した起動記録も使える。Calendar の例は `--origin https://calendar.google.com`。本文や URL のパスにサイト専用の条件分岐を設けない。

`read` は起動記録と PID のコマンドラインを照合し、一つの window の現在の URL/title を AX で特定する。Host の `session.openRead` は Task を要求しない。`ariadne.chrome` grant に canonical origin の配列と readLimits を与え、Read のみで接続する。HTTPS と検証用の HTTP 127.0.0.1 を受け付け、userinfo・不正な URL を拒否する。query/fragment も文書 identity の一部。origin の許可は、古い文書やノード参照の再利用許可ではない。

CLI の標準出力と report はメタデータのみ。`--raw` は画面値を標準出力へ、`--record` は `read-*/observation.json` へ出す明示指定。実画面値やログイン済み profile は外部転送・コミットしない。起動記録や Host 引数には operator が指定した URL が含まれ得るため、ローカルの権限境界内で扱う。

SDK は `openRead(spec)` → `read(session.document[, rootRef])`。`refreshPage()` は保持 window 内の現在文書を許可 origin の範囲で再選択し、旧参照を失効する。refresh は取得回数・期限・journal をリセットしない。maxNodes/maxDepth/maxBytes/maxCaptureMs/maxCaptures/deadlineMs を制限し、読み残しを `partial` で返す。CLI では `--max-nodes`、`--max-depth`、`--max-bytes`、`--max-capture-ms` で予算を指定できる。既定は32,768要素・深さ128・16 MiB・10秒。セッション全体は10回・60秒で、回数より先に期限で止まることがある。

Model/Act・操作能力は空。frame 本文は省略し、スクロール・遷移・書き込みは行わない。`observed` は列挙範囲の取得を表し、全件取得や意味的な抽出の成功ではない。取得前後の確認は best effort で、AX 呼出しの中断時刻や観測間の未検出の往復遷移は保証しない。設計と対応範囲は [browser-generalization-design.md](docs/browser-generalization-design.md) を参照。

## 証拠付きの属性抽出

```sh
npm run browser -- extract .runtime/browser-session-XXXXXX --origin https://example.org
# AXStaticText の value だけを、原文と証拠付きで表示・保存する
npm run browser -- extract .runtime/browser-session-XXXXXX --origin https://example.org --role AXStaticText --attribute value --raw --record
npm run test:browser-extract
```

`extract` は `project-ax-text.v1`。省略時は全 nativeRole、name/value の両属性を取り出す。`--role` と `--attribute` は複数指定できる。絞り込みは nativeRole の完全一致だけで、サイト名・ラベル・表の列の推測は使わない。同文の別要素は別 record として残す。`--max-records` は1〜65,536（既定32,768）、`--max-output-bytes` は8192〜134217728（既定67108864 = 64 MiB）。観測の上限は `read` と同じフラグで別に指定する。

`projected` は、一度の観測中の対象ノードを取得状態ごと転記したという意味。業務上の項目対応、現時点のページ、全件取得を保証しない。取得漏れ・役割不明・出力切詰めは `partial`、0件かつ範囲に不確実性があれば `unknown`。`no_match_in_observation` も今回の列挙範囲に限る。これらの結果は exit 0 で返るため、呼出し側は status を検査する。契約違反や Host の拒否は exit 1、window 未選択は exit 2。

既定出力は状態と件数。`--raw` で結果本文を表示、`--record` で `read-*/task.json`・`observation.json`・`result.json` を0600で保存する。result の compact JSON と末尾改行を含む UTF-8 バイト数に出力上限を適用する。task/observation/report は別の記録で、この上限の対象外。digest も画面由来の情報なので既定 report に出さない。実画面値は外部モデルへ送らない。

SDK は `runReadTask(host, readSessionSpec, openedSession, task[, signal])`。Task は openRead 後・read 前に固定し、単一 Observation と照合する。`ReadProjection` は Task/Observation の private な凍結コピーを保持し、`project()` と独立した `verify(result)` が元の要素・属性・全文引用・順序・件数・予算を照合する。rootRef を使う場合は同じ生存 Host で先行 read から取得し、その先行観測を結果へ混ぜない。CLI では rootRef を受け取らない。

AbortSignal は進行中の native AX 呼出しを中断せず、戻ってきた結果を拒否する。Host の cancel/refresh/期限検査は既存のまま。Task の永続再開や汎用 provider は追加していない。対応範囲と実測は [browser-extract-status.md](docs/browser-extract-status.md)。

## 読み取り予算の見積もり

実測と根拠は [browser-budget-sizing.md](docs/browser-budget-sizing.md)。32,768要素・16 MiB・10秒の観測と、64 MiB の抽出結果を既定とする。小さいページで上限いっぱいの領域を事前確保するわけではない。大規模ページでは Host と Node のメモリ使用が増えるため、低メモリ環境では CLI から予算を下げられる。

```sh
# 公開資料3件＋合成の一覧・深いツリーを各3回、既定値と手動最大値で計測
npm run test:browser-budget
# 65,536ノード、長文によるバイト制限、深さ256のストレス計測
npm run test:browser-budget -- --stress-only
```

専用 Chrome と localhost の合成ページだけを起動・終了し、Node と Host のピーク RSS、取得・抽出の時間、件数・バイト数を `.runtime/browser-budget-measure-*/` に記録する。Chrome 自体のメモリは集計に含めない。画面本文は保存しない。最大値の計測では20秒×3回と直列化を収めるため、計測用 session の期限だけ120秒にする。production の既定は60秒。各回が best effort の観測であり、同じページでも取得量や時間は変わり得る。

予算の正本は `build_contracts.py`。`make generate` で JSON Schema、TS の `src/browser-limits.generated.ts`、Swift の `BrowserReadBudget.generated.swift` を生成する。上限を変える際は生成物もレビューする。read RPC の応答上限は観測予算＋64 KiB、待ち時間は max(15秒, 取得予算＋5秒) に合わせる。明示した RPC 上限・timeout は維持する。従来の操作 Task の観測上限2048・RPC上限1 MiBは引き上げない。

## Jev の実呼出し

`--provider jev --model jev-1.13.0` と Model grant を明示する。認証は `TYPESAFE_API_KEY`、または macOS の `--keychain`（service `typesafe-api`）。キーはローカルプロセスのメモリで SDK に渡し、ファイル・delegate・ログへ渡さない。

```sh
npm run test:model
npm run test:native-model
```

これらは有料 API を呼ぶ明示的な試験。合成フォームの名前・所属だけを送り、入力値・現在値・oracle を除く。fixture 用の初期設定は `config/calibration.synthetic-forms-v2.json`。実行時には `--calibration` で指定する。preview は校正なしでも可能だが、無校正の実操作は拒否する。この小さい評価を一般アプリ向け校正に拡張しない。

## JSON 契約

Python 3.11 以上と uv を使用し、依存は `uv.lock` に固定。

```sh
make setup
make check
```

`make check` は正例10件・負例38件の JSON と一部の参照整合性を検査する。Core、native、モデル試験の代わりではない。契約を変えるときは `build_contracts.py` を編集する。

```sh
make generate
make check
git diff --check
git diff -- build_contracts.py contracts.schema.json examples/ validation-results.json
```

生成元と JSON を一致させる。例は架空のデータで、実測トレースではない。

## CI

`check.yml` は通常テスト・型・build・契約検査と Swift build。`ax.yml` は手動実行のみで、ログインと AX 許可を持つ専用 `ariadne-ax` self-hosted Mac が必要。モデル試験は API キーと課金を伴うので通常 CI に含めない。定義の追加と hosted job の実行済みを区別する。
