# サイト専用コードを原則増やさない汎用化案

2026-09-20。ユーザーの方針「原則サイト専用の作り込みは避けたい」を前提に、Codex と Fable が2回の設計相談を行い、親が現行ソースと反例を照合した提案。相談後、第1段階の汎用ブラウザ観測セッションを実装した。現行 API と実測は [browser-read-status.md](browser-read-status.md)。第2段階は原文引用基盤 `project-ax-text.v1` を追加した（[実装記録](browser-extract-status.md)）。第3段階は operator が固定した Task と Supervisor の対象選択を使う共通 AX 操作を追加した（[実装記録](browser-action-status.md)）。意味的な項目対応と Ariadne 単体の汎用 Planner は引き続き未実装。以下の設計相談時点のコード参照は履歴として残す。

## 推奨する方向

**ブラウザの観測と操作の機構を共通化し、対象・目的・入力・期待結果を実行時に渡す。最初は、Task から独立したブラウザ観測セッションを作る。**

Calendar、チケット一覧、検索結果を別々のアプリプロファイルとして実装しない。ブラウザの AX 上の違いはブラウザ adapter が扱い、各画面の「どれが対象か」はその回の観測と Task から解決する。サイトごとの selector・手順・スクリプトを設定に移しても、この目的を達成したとは扱わない。

| 層 | 担当すること | サイトごとに変わる情報の扱い |
|---|---|---|
| OS / Browser adapter | AX 属性、native identity、WebArea、フレーム、入力・press の実行 | Chrome 等の基盤の差を扱う。サイトをキーに分岐しない |
| 実行対象と権限 | process/window、許可する origin、Read/Model/Act、期限・予算 | operator が実行時に指定する。アプリの表示文言から権限を作らない |
| Task / レシピ | 読む、欄を埋める、指定した結果へ進む等の目的と固定チェック | URL、対象名、入力値、期待タイトルは正当な Task データ |
| 意味判断 / Binding | 観測内のラベル・role・所属・関係から対象を対応付ける | 観測ごとに解決する。サイト用 selector 辞書を持たない |
| 実行管理 | prepare、失効、commit、記録、cancel、結果不明時の停止 | 全サイトで同じ機構を使う |
| 結果検証 | 実行前に固定した条件と、その条件を支える観測を照合する | 汎用の検査と Task の期待値を組み合わせる。証明できない業務効果を断言しない |

新しいサイトで必要なものが Task 入力だけなら、狙った種類の汎用化である。サイトのために本体や判定テンプレートを書き換えたら、成功例を増やしても、その評価では未達として記録する。

## 設計時点の実装から分けるもの

以下の行番号と Calendar 専用ファイルは、設計相談時点のソースを指す。第1段階の実装で読み取り経路を置き換えた。

- `src/calendar.ts:50` は observe のために合成 `fill-fields.v1` Task をコピーしている。`src/contracts.ts:19`、`Contracts.swift:153` も入力 Task だけを認める。この流用をなくす。
- Calendar の appId は `src/grants.ts:16`、`Contracts.swift:7`、`Host.swift:141`、`AX.swift:398` にまたがる。読み取り専用かどうかは権限とセッションの性質に置く。
- `Host.swift:204` の ObservationQuery は、一部の例外以外は同じ全体 capture に到達する。query 名の追加だけでは部分観測にならない。
- `AX.swift:358` の WebArea 発見自体がページ内容まで2048ノードを探索する。大きなページは、内容を部分取得する前に接続を拒否され得る。`AX.swift:503` の再確認も同じ探索を行う。
- `src/providers/jev.ts:26` の候補は入力欄に限られ、`src/core/runtime.ts:113` の実操作校正も fixture 限定の検査である。これを削除して一般サイト対応とはしない。

現行で残す機構は、属性の取得状態、部分観測、固定した Task と成功条件、観測に束縛した Binding、確定した操作だけの dispatch、durable intent、結果不明時の重複抑止である。

## 権限・画面世代・結果不明の記録を分ける

以下は型の責務を示す案であり、そのまま利用できる現行 API ではない。

```text
ObservationSessionSpec
  operatorScopeRef / process・window / captureLimits / deadline
  Read のみで開ける。Task の inputs や成功条件は不要

PageScope
  operator が許可した origin の集合 / 必要なら path の境界

DocumentStamp
  sessionEpoch / documentGeneration / native document identity
  正確な URL / 選択された frame の identity

Task
  固定した目的・入力・必要チェック・業務上の許可範囲への参照

PreparedOperation
  Task revision / grant version / DocumentStamp
  Binding / command / 正確な引数 / guard / 期限
```

`PageScope` は移動してよい範囲で、現在の文書の同一性ではない。同じ origin でも URL・WebArea・対象 frame が変われば古い Binding と prepare を失効させ、許可範囲内で改めて観測する。query や fragment だけの変化も、操作の束縛を更新する理由になる。

URL 不変の SPA 更新まで DocumentStamp が完全に検知できるとは主張しない。対象と祖先の identity、名前、操作能力、関連する状態の再読を維持する。通知は再読のきっかけで、通知0件を不変の証拠にはしない。

結果不明の記録は、上記の短命な世代から独立させる。operator の安定した認可範囲に結び付く識別子と記録先を用い、Task、文書世代、セッションや grant の版を更新しても未解決の操作を消せないようにする。profile path や origin の変更だけで別名を作り、未解決記録を回避できる設計にも留意する。

現行 Calendar ツールは read のたびに scopeRef と journal を新規作成する（`src/calendar.ts:53`、`:56`）。Read のみでは追加の書き込みを起こさないが、この構成をそのまま Act に流用してはいけない。最初の観測対応で実行用 journal をリセット・移行する必要はない。

URL は一般的な構文規則で処理する。許可 origin の完全一致、port、必要な path の区切りを検査し、userinfo や曖昧な表記は拒否する。query・fragment を一律禁止する代わりに、完全 URL は Host 内の同一性検査に使う。外部サイトを自動的に許可する変更ではない。

URL の認可と秘匿は別の関心である。path にも秘密が入り得るため、既定のログ・モデル入力へ完全 URL や path/query の一覧を自動で出さない。opaque document ref と必要な最小限の表示を基本とし、生 URL の保存や送信には個別のデータ範囲を持たせる。hash を匿名化と呼ばない。

## 最初の変更：汎用のブラウザ観測セッション

最初に `session.openRead` 相当を追加する。Task と入力用チェックを流用せず、Read grant、対象、観測予算、期限で開く。既存の入力 Task の経路は維持し、read セッションから prepare/commit に入る要求は Host が拒否する。

文書の発見と内容の取得を分離する。ブラウザ側の構造をたどって最上位 WebArea を識別し、発見時はページ内部への降下を止める。その文書だけを root として、ノード数・深さ・時間・応答サイズを制限した capture を行う。取得不足は理由付きの partial として返す。

枝刈り探索だけで入れ子の frame 一覧まで得られるわけではない。初段では選択した最上位文書を対象とし、入れ子の WebArea は内容を取得せず、省略を記録する。親子関係や origin を確かめられない frame の内容へは進まない。複数の最上位候補の識別と入れ子 frame の取得は、実 AX で独立に検証する。

Calendar の launcher と window 選択は、URL・起動先を引数にするブラウザ用ツールへ置き換える。ログインは引き続き利用者に引き継ぐ。コード中の Calendar 制約は撤去対象だが、Calendar での評価記録や Task 例を消す必要はない。独立 profile と実ブラウザの起動記録は維持する。

対象ファイルは、`src/contracts.ts`、`src/grants.ts`、`src/host/rpc-host.ts`、`src/cli.ts`、`src/calendar.ts`、`scripts/calendar-window.swift`、Swift Host の `Contracts.swift` / `main.swift` / `Server.swift` / `Host.swift` / `AX.swift`。契約に追加する型・制約は `build_contracts.py` に記述し、`make generate`、`make check`、生成物の確認を行う。既存6契約をすべて作り直すことを前提にはしない。

初段では情報抽出用の新 Task、汎用 Planner、業務用 DSL、ブラウザの任意クリックを一緒に実装しない。部分観測を正しく返せること自体を到達点とする。これにより、その後の抽出や操作に使う共通の観測経路を先に検証できる。

## 次に載せる情報抽出と操作

**第2段階は、観測の根拠を持つ読み取り Task。** 指定領域から列・項目を取り出し、各結果に Observation、DocumentStamp、元の属性や文字列範囲を付ける。日付・タイトル等は Task が求める項目であり、Calendar 専用 parser を基本にはしない。

EvidenceRef が存在するだけでは、抽出内容の正しさを証明できない。原文の転記は実際の属性と一致を照合し、意味的な対応付けや日付の正規化は別の保証として記録する。曖昧な値を推測で埋めない。「表示範囲を読む」と「全件を取得する」では成功条件を分け、後者で部分観測を取得完了にしない。

第2段階の初回実装では、AX の役割による絞り込みと name/value の全文引用に限定する。現行 Node に列 index・span・header の関連付けがないため、表の列数が一致するだけで見出しとの対応を保証しない。Record は観測した AX ノードであり、業務レコードではない。意味的な対応付けの予約 enum やモデル許可は追加しない。

**第3段階は、限定した Task のもとでの共通操作。** 入力や press をサイト名ではなく、観測に束縛した対象、ユーザーが許可した目的・データ・操作回数、固定した検査で扱う。未見の画面に対する意味判断を測定し、現在の fixture 校正を一般サイトへ自動拡張しない。

ここで「欄への入力＝ローカルだけ」「次へ＝表示だけ」と分類してはいけない。既存のブラウザ fixture 自体も、入力値を URL を変えず POST している（`test/browser-acceptance.ts:36`、`:50`）。値・URL・AX identity の一致は、サーバー側への副作用がない証拠にはならない。DOM adapter でもこの業務上の問題は残る。

区別するのは、(1) 操作可能という機械的事実、(2) 起きる効果の推定と根拠、(3) ユーザーが許可した業務範囲、(4) 実際に確認できた結果である。意味判断は許可された Task の中で対象を選ぶもので、grant を生成・拡張する権限ではない。

例えば、ユーザーが指定文書の指定欄の更新を依頼し、通常の自動保存まで含むその編集が許可範囲に収まるなら、その Task 内の複数の入力を自動で続けられる。「ビュー移動による副作用を何でも許容する」のような包括的な許可は採らない。対象・データ・受信者・目的から外れる変更や、目的との対応が不明な操作で引き継ぐ。通常の入力すべてに一律で確認や追加の risk モデル呼出しを挟むことも前提にしない。

画面上の値の一致と、サーバーへの保存・送信・業務処理の成立は分けて報告する。後者の確かな根拠がないとき、前者を代用して完了条件を弱めない。少数の難しい業務効果に特別な連携が必要になった場合は、共通系へ隠して組み込まず、例外として必要性を判断する。

## サイトに依存しないことの評価

本体、契約、モデル・校正設定、意味判断テンプレートを固定し、評価者が後から選んだ別の構造・ラベル・言語のページを実行する。変更できるのは対象 scope と Task の意味・入力・期待値だけで、ハーネスからサイト用 selector、hidden ID、正解を含む操作手順を供給しない。oracle は採点側にだけ置く。

初段の候補は、現行 Calendar と、事前調整していない公開の一覧ページ・表を含むページ、構造を変えた合成ページ群。実サイトの選定と追加検証は実装段階で行う。Calendar の成功だけで未見サイトへの適合を認めない。

| 反証ケース | 見る結果 |
|---|---|
| 未見の構造・同名ラベル・別言語 | 本体変更なしでの取得率。第2段階以降は誤対応・誤抽出も数える |
| 2048ノードを超えるページ | 文書の特定と、予算に収まる partial の取得を別々に確認する |
| query・fragment・SPA・文書交換 | 許可範囲内への再接続と、古い参照・prepare の拒否を両方確認する |
| 入れ子 frame・別 origin・識別不能な候補 | 許可していない本文の取得0件。省略・拒否を正直に返す |
| Read のみのセッションへの操作要求 | 実機で dispatch 0件。偽造された command と model 権限も拒否する |
| sensitive な URL・画面値 | 許可していない log/model 出力0件。メタデータを通じた漏れも検査する |
| URL 不変の自動保存、見かけ上無害な press | oracle の外部効果と観測結果を分け、過剰な成功主張を検出する |
| 操作後の応答喪失・新 Task・新文書世代 | 未解決操作の記録を保持し、再 dispatch 0件を確認する |

成功率だけでなく、拒否率・誤対象率・誤成功率・未取得率・追加のサイト用コード量・時間・モデル呼出し量を記録する。全件を拒否する系を「安全な汎用化の成功」とは評価しない。合成テストと実機、既知と未見を分ける。

AX を先に進め、対象文書の特定失敗、仮想化・フレーム・必要属性の欠落が実測で主要な失敗原因になった時点で DOM adapter を比較する。導入する場合も上位の scope、Task、prepare/commit、検査は共通にし、AX が失敗した場面で暗黙に別方式へ切り替えない。

## Fable との相談と親の判断

使用スキルは [claude-code-delegate](https://github.com/annenpolka/skills/tree/main/claude-code-delegate)。Claude Code 2.1.278、指定モデル `fable`、両回の実モデルは `claude-fable-5-1`。session ID は `2e0c8556-b804-4019-95e1-5631f476b3f9`。同じ session に初案への反例を返して修正した。

両回とも exit 0、`subtype: success`、`is_error: false`、permission_denials は空。初回19ターン、再開3ターン。system/init で `permissionMode: default`、tools が Read/Glob/Grep のみ、MCP サーバーが空であることを確認した。safe-mode、strict-mcp-config、no-chrome を両回に明示し、初回は24ターン・推定12USD、再開は既読部分の設計修正として12ターン・推定6USDに制限した。金額は CLI の見積り上限で、請求額ではない。

渡したのは、現在のリポジトリから選んだ64ファイルのソース・合成試験・説明文書のコピー。実際の予定、観測ログ、profile、認証情報は渡していない。実行記録は `.runtime/delegation/fable-generalization/`。親が初回・再開後に元のファイル集合と SHA256、コピーの集合と SHA256 を比較した。コピーと元の実装・試験は不変で、最終的な追加・変更は親が作成した本書と README の案内だけだった。

初案から採用したのは、基盤 adapter と実行時の scope/Task の分離、サイトごとの常設手順を増やさないこと、AX での読み取りから段階的に評価する方針である。親の反例により、Fable は「値と URL で外部副作用を検出」「query 全拒否」「サイト名 grep が汎用化の証拠」「部分観測を追加すれば文書発見も解決する」を撤回した。

再案もそのまま採用していない。ページ発見時の枝刈りだけで全 frame を列挙できるとは扱わず、EvidenceRef の存在だけを正しい抽出とせず、効果への包括的なリスク引受けを grant の既定にしない。scopeId を profile/origin から作れば継続性が保証されるとも扱わない。これらは本書の境界と受入条件に反映した。

この節は最初の設計相談の記録であり、実装や適合試験の証拠にはしない。続く実装委譲、親レビュー、実機試験は [第1段階の実装記録](browser-read-status.md) に分けて記載する。
