# 汎用ブラウザ読み取り：第1段階

現在の予算は [browser-budget-sizing.md](browser-budget-sizing.md) の実測に基づく値へ更新した。以下の上限表と件数は第1段階の実装・測定時点の記録である。

2026-09-20。サイト専用 profile を増やす方式から、共通 Chrome adapter に origin と取得予算を渡す方式へ移行した。`codex/implement-runtime` 上の未コミット・未プッシュの変更。実行結果はローカルの macOS / Google Chrome 153.0.8010.50 でのもの。hosted CI は実行していない。

## 実装した範囲

`ariadne.google_calendar_readonly`、Calendar の URL parser、専用 capture、専用 CLI を削除し、`ariadne.chrome` と `npm run browser` に置き換えた。サイトのドメイン・表示パス・ラベルに分岐する処理は本体に加えていない。入力用 localhost fixture の `ariadne.chrome_fixture` は独立した制約を維持する。

読み取りは Task を要求しない。`ReadSessionSpec` に scopeRef と上限を指定し、operator grant は `pageScope.origins` と `readLimits` を持つ。Read のみ、Model/Act は false、操作能力・許可コマンドは空。偽の入力 Task や成功チェックを作らず、結果は `observed` とする。

| RPC / TypeScript | 入力と結果 |
|---|---|
| `session.openRead` / `openRead(spec)` | `{spec}` → Session + DocumentStamp |
| `observation.read` / `read(document, rootRef?)` | 文書世代と任意の取得済み領域 ref → Observation |
| `page.refresh` / `refreshPage()` | 保持 window の現在文書を再選択 → 新しい DocumentStamp |

DocumentStamp は `{sessionEpoch, ref, generation}`。URL・パス・query を含まない opaque ref を用い、旧文書・旧ノードの参照は refresh や検出した文書変更で失効する。HTTP は 127.0.0.1 のみ、公開ページは HTTPS、origin は scheme/host/port の完全一致。query/fragment を含む生の URL は文書の識別に保持し、userinfo・曖昧なポート表記・不正な percent escape 等を拒否する。現段階では ASCII host のみ。

ウィンドウとプロセスの識別を保持し、文書の URL と top-level WebArea を取得前後に確認する。独立 Chrome では AppKit の launchDate が nil だったため、OS のプロセス開始時刻を PID の世代として使う。再接続時の title 変更は、保持した同じ native window の範囲で認める。

文書発見は WebArea で探索を止め、本文取得と分離する。本文は件数・深さ・JSON 応答バイト数・時間を制限し、入れ子 WebArea は role の確認後に本文を読まず省略する。取得済みの領域を指定して読み直せる。失敗・切り詰め・frame・秘匿を省略理由として返し、全件取得と扱わない。

| readLimits | 許容範囲 | CLI 既定値 |
|---|---:|---:|
| maxNodes | 1–2048 | 2048 |
| maxDepth（root は0） | 1–128 | 64 |
| maxBytes（Observation の JSON） | 8192–524288 | 524288 |
| maxCaptureMs | 100–5000 | 3000 |
| maxCaptures | 1–100 | 10 |
| deadlineMs | 1000–600000 | 60000 |

要求値は grant の各上限以下でなければ拒否する。取得の試行も回数を消費し、refresh で回数・期限を回復しない。read session の再 open や Task・operation への切り替えも拒否する。既存 journal の未解決操作を削除せず、同じ scope の未解決 ID を報告する。read の回数と期限は Host プロセス内の予算であり、再起動をまたぐ累積予算ではない。

標準出力・report はメタデータが既定。生の AX 値は `--raw` で表示、`--record` でローカル保存する。既存 Calendar の専用起動記録も使える。操作例は [CONTRIBUTING.md](../CONTRIBUTING.md#汎用ブラウザの読み取り)。

## 親が実行した検証

| 経路 | 結果 | 証拠 |
|---|---|---|
| JSON 契約 | 正例7件・負例26件。生成元から再生成 | `make generate` → `make check`、`validation-results.json` |
| TypeScript | strict typecheck / build、109件成功 | `.runtime/browser-read-unit-final.txt` |
| Swift 単体 | 4件成功。URL 規則、grant、read spec、操作拒否 | `.runtime/browser-read-swift-final.txt` |
| 実 Chrome 読み取り | 15項目成功 | `.runtime/browser-read-lr3GK9/report.json` |
| 実 AX fixture 回帰 | 11シナリオ成功 | `.runtime/browser-read-native-accepted.txt` |
| 既存 Chrome 入力回帰 | 2欄と独立 DOM oracle が一致、Submit 0、URL 変更後は未 dispatch | `.runtime/browser-xgXaEM/report.json` |

読み取りの実機試験は、4,100行の合成ページでの接続・部分取得、領域による本文回収、cross-origin frame の秘匿、文書/ノード参照の失効、4種類の取得上限、取得回数・期限の維持、取消、query/fragment と title の変更、範囲外への遷移、偽造された操作要求を含む。TypeScript の guard を迂回した RPC も Native 側で拒否された。合成した過去の dispatch intent が read/refresh 後も unknown として残ることを確認し、別の実 AX 回帰では実際の Host クラッシュ・応答喪失後の重複 dispatch 抑止を確認した。

最終候補のソース30ファイルを SHA256 で固定し、次のページを同じ実装で取得した。取得後にもハッシュ一致を確認した。予定の内容はモデルや委譲先へ送っていない。

| 実 Chrome の対象 | ノード数 | 取得状態 | 取得時間 |
|---|---:|---|---:|
| 既存のログイン済み Google Calendar | 592 | provider_exhausted | 106ms |
| W3C Tables with Two Headers | 743 | provider_exhausted | 140ms |
| RFC 9110: HTTP Semantics | 1745 | partial / budget | 295ms |
| MDN WAI-ARIA Roles | 1724 | partial / budget | 295ms |

公開ページの root title と本文が目的の文書であることを親が確認した。W3C では AXTable 2件、RFC では AXTable 1件も取得した。意味的な表の抽出・項目対応付けを検証した結果ではない。いずれもモデル呼出し0・操作0。`provider_exhausted` も、今回 provider が列挙した範囲を取り切ったという意味で、アカウント内の全予定や未表示データの網羅ではない。

証拠は `.runtime/browser-read-real-pages-accepted/report.json` と、そこに記載した private な観測ファイル。最終固定の manifest は `.runtime/browser-read-frozen.json`。Calendar の profile はそのまま残し、公開ページと合成試験の専用 Chrome は終了した。

## 初回失敗と修正

失敗した試行も保存している。最初から未見ページに全件成功したとは扱わない。

- 合成ページの初回試験は、部分取得した全体観測に深い階層の本文も含まれると誤って期待した。試験を領域指定による追加取得へ分けた。`.runtime/browser-read-live-first.txt`。
- プロセス識別を強めた親の変更が、独立 Chrome の nil launchDate を拒否した。OS の開始時刻に置き換えて再検証した。`.runtime/browser-read-live-second.txt`。
- W3C の最初の公開ページ試験では、翻訳ポップアップが別 AXWindow として現れ、「window が一つ」という CLI の条件が失敗した。許可 origin の文書を持つ window が一つだけ見つかる条件へ修正した。複数の対象文書から配列順で選ばない。サイト・翻訳文言の分岐は追加していない。`.runtime/browser-read-real-pages/report.json`。
- 修正後の RFC 初回は読み込み中に `stale_binding` となった。実装を変えず、ハーネスが表示の安定を2秒待ってから再試験した。`.runtime/browser-read-real-pages-final/report.json`、`browser-read-real-pages-settled/report.json`。ロード完了を自動判定する機能の証拠ではない。
- 親レビューでは、capture 全体への時間予算適用、期限経過後の応答拒否、起動失敗・取消時の observer callback の参照寿命も補強した。最後の補強後に全実機回帰と4ページを再実行した。

## 委譲と受入

[claude-code-delegate](https://github.com/annenpolka/skills/tree/main/claude-code-delegate) を使用。指定モデル `fable`、実モデル `claude-fable-5-1`、session `e76f6b13-ee38-431e-a339-fb70ac20bb43`。Swift 側のみを65ファイルのソースコピーで委譲し、TypeScript、契約生成、CLI、試験、文書は親が実装した。

CLI は exit 0 / success / is_error false、permission_denials は空。system/init で acceptEdits、Read/Glob/Grep/Edit/Write、MCP サーバーなしを確認した。safe-mode、strict-mcp-config、no-chrome を明示。親が変更ファイルを6本の許可範囲と照合し、その他のコピーが不変であること、記録されたツールの指定パスがコピー外を指さないことを確認して取り込んだ。実画面・Cookie・認証情報はコピーに含めていない。

委譲先はビルドも試験も行っていない。上の受入結果はすべて親が統合・修正したコードに対して実行したもの。生の委譲記録は `.runtime/delegation/fable-browser-read/` に非公開で保存した。

## 対応の限界

読み取りは best effort。時間予算は呼出し間のチェックであり、OS の AX 呼出しを途中で強制中断する仕組みではない。frame 本文、スクロール、非公開/仮想化された要素の回収、読み込み完了待ち、URL が同じままの SPA 更新の完全検知、観測間に往復した未検出の遷移は保証しない。複数の top-level WebArea や探索上限で識別できない window は拒否する。保持できる参照数にも上限があり、整理で失効した参照は再取得が必要になる。

取消時は Native の処理中チェックと client の世代チェックを使い、client は取消後の遅い成功を受け入れない。Native の最終チェックから stdout 書き出しまでの完全な原子性までは保証していない。

予定や表の項目を根拠付きで抽出する Task、一般サイトでの入力・press・遷移、業務効果の検証は未実装。今回の4ページの読み取りを、それらの完成や全サイトへの適合と扱わない。
