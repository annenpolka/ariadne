# Google Calendar の読み取り（旧専用 profile の記録）

現在は Calendar 専用 profile と CLI を削除し、[汎用ブラウザ読み取り](browser-read-status.md) に移行した。以下は移行前の実測記録であり、現行の使用手順ではない。

2026-09-20。独立プロファイルの実 Chrome で、ユーザーがログインした Google Calendar の表示を AriadneHost の macOS AX 経由で取得した。コードは `codex/implement-runtime` 上で未コミット・未プッシュ。

## 実行結果

- 接続先は `https://calendar.google.com/calendar/u/0/r`。専用 Chrome PID は11391。
- 表示中の週の見出しと6件の予定について、日時・タイトルを含む AX 名を取得した。予定の詳細を開く、期間を移動する、作成・編集する操作は行っていない。
- 観測は593ノード、`provider_exhausted`、omittedReasons は空。これは今回の AX 列挙範囲の取得結果であり、アカウント内の全予定や画面外の期間を網羅した意味ではない。
- `consistency: best_effort`。観測は328ms、eventSeq は0/0。通知がないことから画面の不変性を推定しない。
- 各ノードの操作能力は空。モデル呼出し0回、操作0回、dispatch intent 0件。Host は読み取り後に終了し、専用 Chrome を残した。

ローカル証拠は `.runtime/calendar-0zwvvj/read-017d1d08-f6a4-4c23-984e-3a1197fb9bbb/` の `observation.json`、`report.json`、`host.jsonl`。実際の予定・アカウント情報を含む観測とログイン済み profile は `.runtime/` に置き、コミット・委譲・モデル送信しない。

## 追加した範囲

登録 profile は `ariadne.google_calendar_readonly`。入力用の `ariadne.chrome_fixture` は従来の localhost 限定を維持する。Calendar 用は HTTPS の `calendar.google.com` の登録済みカレンダー表示パスだけを受け付け、ポート、userinfo、query、fragment、ログイン先や編集・設定ページを拒否する。対象 URL の文字列、PID、Chrome bundle/executable、window title/native identity、単一 WebArea の native identity を確認する。観測前後で window の AXDocument と WebArea の AXURL を再確認する。

grant は Read のみ。Model/Act、allowedCommands/allowedActions、操作・意味判断予算の付与を拒否する。handshake と Observation に操作能力を出さない。観測対象は window の識別情報と、保持した Calendar WebArea の子ツリーで、ブラウザのツールバー・タブは含めない。

`npm run calendar -- open` は毎回新規 profile を作り、Google Calendar を通常ウィンドウで開く。既存 profile のログイン情報はコピーしない。`read SESSION_DIR` は起動記録と対象 PID のコマンドラインを照合し、専用 Chrome の現在の Calendar URL/title を AX で特定して Host へ渡す。`status` は対象画面の状態だけを返す。認証画面ではコンテンツを取得せずログインをユーザーに引き継ぐ。

現行の session.open は fill-fields Task を必須とするため、読み取りツールでは既存 Task を観測セッションの入れ物としてのみ使用する。Core の execute や成功条件の検査を実行せず、結果は `observed` とする。読み取りレシピや `verified_success` の実装として扱わない。

## 検証

Swift の3試験で URL の許可・拒否、権限拡張の拒否、操作能力のない handshake を確認した。通常テスト96件、TypeScript strict typecheck/build が成功。既存の Chrome 合成フォームも `.runtime/browser-TqHi8f/report.json` で成功し、2欄の入力と DOM oracle の一致、秘密欄・無効欄・誤ページの拒否、同名タイトルの URL 変更後の `not_dispatched / precondition_changed` を維持した。

通常テストの記録は `.runtime/calendar-core-tests.txt`、Chrome 回帰は `.runtime/calendar-browser-regression.txt`。6種類の生成 JSON 契約は変更していない。Swift test の CI 定義を追加したが、hosted CI は実行していない。

この実行で確認したのは、一つのログイン済み Calendar 週表示の AX 読み取り。ほかの表示形式・大規模カレンダー・複数 frame・画面遷移・予定の書き込みは未検証。外部 GUI の取得は原子的ではない。
