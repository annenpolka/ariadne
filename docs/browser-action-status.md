# 共通ブラウザ操作の実装と検証

2026-09-20。`ariadne.chrome` に、operator が固定した `browser-actions.v1` Task に沿って AX の値設定と press を行う経路を追加した。サイト名、Calendar のラベル、DOM selector、操作順のサイト別分岐は実行エンジンへ追加していない。具体的な目的・入力・手順は実行時の Task、対象選択は外側の Supervisor が持つ。

Codex が観測→対象選択→実行→再観測をつなぎ、実 Chrome の Calendar で許可されたテスト予定を作成した。途中でユーザーの手操作を要求せず、保存・一覧表示・開き直した編集画面の照合まで進めた。これは連続操作の実証であり、Ariadne 単体に自然言語の目標だけを渡して完走する Planner の実装ではない。

## 契約と実行経路

- `BrowserActionTask` は目的、入力、順序付きの1〜100手順、1〜16件の画面検査、取得予算を固定する。入力値は Task の `inputs` だけから取得し、RPC から任意の文字列を注入できない。
- operator grant の `actionPolicy.task` に Task 全体を固定する。同じ `ariadne.chrome` でも Read のみの grant では操作を拒否する。`model:false` を維持し、今回の経路から Jev を呼ばない。
- `session.openAct` → `observation.read` → `action.prepare` → `action.commit` を使う。prepare は次の未完了手順、最新の観測 ID、その観測に含まれる targetRef を要求する。入力・press のどちらも直列に実行する。
- prepare/commit では process、window、完全 URL、WebArea、対象の native identity・role・名前・値・enabled、観測した祖先、focus、native sheet、直接 AX capability を再検査する。準備の有効期間は最大10秒。実操作後や文書 refresh 後には再観測が必要になる。
- 既存 fixture と新しい操作経路は `DurableDispatch.swift` を共有する。永続 intent の前後で検査し、AX 呼出し・結果記録に疑義があれば `outcome_unknown` とする。`attempted` は AX 呼出しの記録であり、保存成立の証明ではない。
- operation ID は Task ID・revision・step ID から決定する。同じ手順を再送・再開しても実行を重ねず、保存したレシートを返す。再起動で Task 内容・期限・実行済み手順はリセットしない。
- CLI は専用 profile の `read-host.jsonl` を継続利用する。その記録に未解決操作が一つでもあれば、別 Task・revision・scope でも変更を止める。読み取りと状態照会は継続できる。未知の結果を自動解決する機能はまだない。

`set_value` は AXTextField / AXTextArea / AXComboBox、`invoke` は AXButton / AXPopUpButton / AXMenuButton / AXMenuItem / AXCheckBox / AXRadioButton / AXLink / AXDisclosureTriangle の範囲で、operator がさらに制限できる。role の一致は業務効果の許可ではない。Task の目的と各対象との意味的な対応は Supervisor が判断する。

## 実行した検証

| 境界 | 結果 | ローカル証拠 |
|---|---|---|
| JSON と参照整合性 | 正例11件・負例42件 | `validation-results.json` |
| TypeScript | 通常142件、typecheck、build 成功 | `.runtime/browser-actions-unit-final.txt` |
| Swift 単体 | 13件成功 | `.runtime/browser-actions-swift-final.txt` |
| 共通操作・実 Chrome | 9項目成功、保存側 oracle は1回 | `.runtime/browser-action-test-8OPCmx/report.json` |
| 共通読み取り・実 Chrome | 15項目成功 | `.runtime/browser-read-8HcS0d/report.json` |
| 属性抽出・実 Chrome | 7項目成功 | `.runtime/browser-actions-extract-final.txt` |
| 既存 Native AX fixture | 11シナリオ成功 | `.runtime/native-acceptance-672cc739-db19-46f0-a187-c7a238fd66df/report.json` |
| 既存 Chrome 入力 fixture | AX 入力と独立したページ側照合が成功 | `.runtime/browser-actions-browser-fixture-final.txt` |

新しい操作試験は実際の専用 Chrome と合成ローカルページを使う。Task の差し替え、任意の値や参照の注入、順序違反、disabled・secure・入れ子 frame、refresh 後の prepare、DOM 要素の交換を拒否した。入力値の native AX 読み戻しとページ側の値を別々に照合した。Save の RPC 応答だけを捨て、重複 commit と Host 再起動を経てもページ側の保存回数は1回だった。別 Task・revision・scope の未解決 intent でも新しい変更を止めた。

最初の開発中には Swift の構文エラーと、生成と build を同時に走らせたことによる生成ソース変更エラーがあった。修正後に生成、build、単体、実機回帰を通した。回帰試験は新しい専用 profile を使い、実 Calendar の予定を追加し直していない。

## 実 Calendar で確認した範囲

ユーザーがログインした専用 Chrome と明示的に許可した予定の内容を使用した。汎用 CLI と AX だけでフォームを開き、日付・時刻・タイトルを入力して保存し、該当週へ移動し、予定を開き直した。DOM/CDP、Calendar API、座標・キー入力への代替は使っていない。

一連の操作は5個の固定 Task、計15回の AX 操作（値設定5回、press10回）。予定の Save は1回。途中で Host を閉じ、同一 Task・revision を再開しても、保存済みの8手順を再実行せず残りの確認へ進んだ。

保存通知、カレンダー内の該当予定1件、開き直した編集画面のタイトル・開始日・終了日・開始時刻・終了時刻・空のゲスト欄を照合し、タイムゾーンも画面上で確認した。確認後は編集画面を保存せず閉じ、予定が表示されたカレンダーを残した。親の検査は `.runtime/browser-actions-live/live-acceptance.json`、実行時のソース digest は同ディレクトリの `live-engine.json` にある。実行後、console の最終分類にも別 Task の未解決操作を反映する修正を追加し、通常試験を再実行した。この修正後に実予定を再作成してはいない。

Task にある原文検査の `observed_success` / `assurance:screen_only` は、固定文字列が観測内にあることを表す。同じ文字列が既存予定や未保存フォームにあっても一致し得るため、それ単独で新規保存を証明しない。今回の保存通知・一覧・編集画面の照合は親が追加で確認した証拠であり、Calendar サーバーの内部状態を API で検証した結果ではない。

予定の具体値、他の予定、アカウント情報、profile、実画面の記録はローカルの `.runtime/` に保持し、公開ソースと Fable の入力から除外した。同梱の Task 例と試験データは架空のもの。

## 対応限界

外側の Supervisor が手順を組み、最新の観測から対象を選ぶ必要がある。Task の `purpose` は記述であり、Host に意味理解を追加するものではない。Jev の fixture 校正を一般サイトへ広げたとは扱わず、未見サイトでの自動対応付けの成功率も未測定。

操作 guard は文書 root までの観測済み祖先を必要とするため、現在は全体観測を起点とする。領域だけの読み取りから直接操作する一般経路は未対応。入れ子 frame、secure な入力、取得できない capability は拒否する。同一 URL の SPA 更新や HTML モーダルをすべて検出できる保証はなく、native identity・属性・focus の再読も外部 GUI との原子的な操作にはならない。

`model:false` は Ariadne 内部から provider を呼ばないという grant。`--raw` は operator が画面属性を読む明示的な選択であり、今回の Codex による対象選択でも使用した。外側の利用者による転送まで技術的に封じる情報境界ではない。`--record` を付けた生の観測・準備内容は公開しない。

## Fable との相談と親の判断

[claude-code-delegate](https://github.com/annenpolka/skills/tree/main/claude-code-delegate) を使用。Claude Code 2.1.278、指定 alias は `fable`、両回の実モデルは `claude-fable-5-1`、session は `e76f6b13-ee38-431e-a339-fb70ac20bb43`。設計相談と実装レビューを同じ session で行った。

Read/Glob/Grep のみ、permission mode は default、MCP は空。各回に safe-mode・strict-mcp-config・no-chrome を明示し、exit 0・is_error false・permission_denials 空を確認した。レビュー用コピー100ファイルの集合と SHA256 が不変だったことを親が確認した。実行証拠は `.runtime/delegation/fable-browser-actions/acceptance.json`。

Fable の指摘を受け、祖先の再検査は必要な名前・role の取得に絞り、focus 読み取り前の timeout 設定を追加した。共通 journal と dispatch の共有、Task 全体の認可への固定を採用した。領域観測からの操作、文字列一致による保存の誤判定、外側の raw データ利用は上記の制約として残した。新しいノードに文字列が現れたことだけを保存の証拠にする案は採用していない。最終の実機操作・照合・回帰試験と受入判断は親が行った。
