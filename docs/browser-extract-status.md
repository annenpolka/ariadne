# 汎用の証拠付き属性抽出

現在の予算と再測定は [browser-budget-sizing.md](browser-budget-sizing.md)。以下の2048要素・1 MiB等は証拠付き抽出を導入した時点の値で、現行の既定値ではない。

2026-09-20。`project-ax-text.v1` を実装し、production CLI の `browser extract` から実 Chrome の AX 観測へ接続した。第2段階の原文引用基盤であり、意味的な項目抽出の完成ではない。変更は未コミット・未プッシュ。

## 実装した境界

- `ReadTaskSpec` は読み取り session、scope、DocumentStamp、任意の領域 root、AX nativeRole の完全一致フィルタ、name/value、出力予算を固定する。サイト名・ページ文言・列見出しを本体の条件分岐にしない。
- `runReadTask` は Task をコピーして固定したあと、一回の `ReadHost.read` だけを呼ぶ。モデルや操作 API を渡す provider callback はない。権限、取得期限・回数、文書の失効は既存の Host に残す。
- `ReadProjection` は Task と単一 Observation の private な凍結コピーを保持する。`project()` は要素ごとに指定属性の取得状態を写し、available な文字列には観測 ID、nodeRef、属性、全文の Unicode scalar 範囲を付ける。
- `verify()` は抽出器を呼ばず、元の Task/Observation から要素の順序・親参照・属性・全文引用・digest・件数・予算・切詰め理由・status を検査する。同文の別要素、別属性の引用、根拠の差し替えは通さない。
- 空文字は available の `0..0`。unavailable/unsupported/redacted/error を空文字へ変換しない。同文の別要素は別 record。結合文字や空白を正規化しない。文字範囲は書記素クラスタではなく Unicode scalar、片割れの surrogate は引用として拒否する。
- 結果は観測順の連続した prefix。record の途中で文字列を切らない。maxRecords は最大2048、maxOutputBytes は最大1 MiB。最長 status 用の envelope を予約するため、実サイズに数 byte の余白があっても次の record を含めない場合がある。
- `result.json` と `--raw` は compact JSON＋末尾改行で、実際の UTF-8 出力量を予算内にする。別に保存する Task/Observation/report は結果の出力予算に含めない。
- document 付き Observation の error/redacted 属性は、coverage の partial と対応する省略理由を必須にした。legacy の操作 Task の Observation にはこの追加条件を適用しない。

`name` は Ariadne が AXTitle、次に AXDescription から取得した属性で、生の AXTitle そのものという保証ではない。value も Host が文字列化した結果で、native API の元の型までは表さない。parentRef は AXChildren の取得経路であり、視覚・意味上の所属を保証しない。record 数は予定や業務レコードの件数ではない。

## 結果の意味

| status | 示すこと |
|---|---|
| `projected` | provider が列挙した観測範囲で、フィルタに一致した全ノードの指定属性を取得状態ごと転記した |
| `partial` | 取得範囲の省略、role 判別の不確実性、または結果出力の切詰めがある |
| `no_match_in_observation` | 取り切った観測の中で指定 role に一致しなかった。ページ全体の不在ではない |
| `unknown` | 一致0件で、取得範囲や role に不確実性がある |

source.coverage、selectionUncertain、outputTruncated を別に返す。属性状態を保持するので、`projected` でも unsupported/unavailable は残り得る。成功という意味で exit 0 を解釈せず、呼出し側が status を検査する。

明示する completeness は `observed_region` のみ。全件取得、表の列対応、予定の日付・タイトルの意味、日付正規化、現在の画面との継続的な一致、原子的な観測は保証しない。表の列数一致から colspan/rowspan や header の対応を推測する案は採らなかった。

領域 root は同じ生存 Host の先行 read で取得できる。証拠には領域 read の一回分だけを用い、先行観測と混ぜない。CLI は他プロセスの rootRef を受け取らない。AbortSignal は処理中の AX 呼出しを強制中断せず、戻った結果を拒否する。永続 Task ledger・resume・モデル抽出・一般操作はこの増分に含まれない。

## 親が実行した検証

| 経路 | 結果 | ローカル証拠 |
|---|---|---|
| TypeScript strict・build | 成功 | `npm run typecheck`、`npm run build` |
| 通常テスト | 135/135、新規26件を含む | `.runtime/browser-extract-unit-final.txt` |
| JSON 契約 | 正例10・負例38 | `make generate` → `make check`、`validation-results.json` |
| production extract CLI → 実 Chrome → Native AX | 合成ページの7項目成功 | `.runtime/browser-extract-native-accepted.txt`、`.runtime/browser-session-wmT2me/extract-acceptance.json` |
| 既存の実 Chrome AX 読み取り | 15項目成功 | `.runtime/browser-extract-read-regression.txt`、`.runtime/browser-read-GXHZhf/report.json` |

新規通常試験は生成元の架空例を独立した期待値にして scalar span/digest を照合する。重複値、空文字、取得状態、役割不明、部分取得、record/UTF-8 予算、別要素・属性の正しい引用による偽装、順序変更、欠落、文書・領域・Task の変更、呼出し中の Task 変更、cancel 後の遅延応答を検査した。JSON の形の検査だけで原文との一致を保証するとは扱わず、保存した Task/Observation を使う `ReadProjection.verify` が必要。

実 Chrome の7項目は Unicode と同値2要素の引用、既定 metadata と保存 opt-in、record 上限、raw stdout と保存 result.json の実バイト上限および0600、partial の0件を unknown とすること、列挙終了時の no-match、秘匿属性の保持。合成ページの input/click effect カウンタは0。一般サイトの任意の副作用がない証明ではない。

初回実機試験はパスワード欄を含むページを `projected` と期待して失敗した。実結果は omittedReasons=[redacted] の partial で、Host の動作が正しかった。合成ページを完全取得と秘匿欄の2ケースに分けた。失敗記録は `.runtime/browser-session-lRbuHz/extract-acceptance.json` に残す。親が修正したのは試験期待値・構成で、秘匿による partial を抑制していない。

今回 Swift のソースは変更していない。Swift 単体・操作 fixture の先行実績は [第1段階](browser-read-status.md) の記録であり、今回の再実行件数には含めない。GitHub hosted CI は未実行。

## 同じコードで確認した実ページ

既存の独立 Chrome の Calendar と、新規独立 Chrome の公開ページを production CLI で読んだ。モデル呼出し・操作は各0。読み取りエンジン29ファイルの SHA256 を固定し、ページ間と実行後に一致を確認した。

| ページ | 観測 node 数 | 出力 record 数 | 結果 |
|---|---:|---:|---|
| ログイン済み Calendar | 592 | 592 | `projected`、provider_exhausted、出力切詰めなし |
| W3C two-headers tutorial | 743 | 743 | `projected`、provider_exhausted、出力切詰めなし |
| MDN ARIA roles reference | 1724 | 1651 | `partial`、観測は budget で省略、結果も出力予算で切詰め |

証拠は `.runtime/browser-extract-real-final/report.json` と `frozen.json`。Calendar の実画面値はローカルの0600ファイルだけに保存し、Fable などの外部モデルへ渡していない。W3C の表を読んだことは列の意味を抽出した証明ではない。これらは第1段階でも使った画面であり、未知サイト全般への精度評価ではない。

## Fable との相談と受入

[claude-code-delegate](https://github.com/annenpolka/skills/tree/main/claude-code-delegate) を使用。Claude Code 2.1.278、指定 alias `fable`、system/init の実モデル `claude-fable-5-1`。前回の session `e76f6b13-ee38-431e-a339-fb70ac20bb43` を4回再開し、設計相談、反例による修正、実装レビュー、レビュー修正の確認を行った。

各回に default permission mode、Read/Glob/Grep のみ、safe-mode、strict-mcp-config、no-chrome を明示。全回 exit 0 / subtype success / is_error false / permission_denials 空で、実効 mode と空の MCP server 集合も確認した。ソースのコピー76ファイルから始め、実装を加えた82ファイルでレビューした。各回の後にファイル集合と SHA256 が変わっていないことを親が確認した。Calendar の raw 観測、profile、認証情報はコピーしていない。

Fable の表構造案に対し、親は列 index/span/header の情報不足を指摘し、Fable が保証の主張を撤回した。追加相談の役割不明、属性状態、独立した verifier を実装へ反映。レビューでは raw の pretty JSON が compact で測る予算を超え得る点と、別 Host が矛盾した coverage を返し得る点を修正した。Fable は再レビューで重大な残存問題なしと報告したが、試験は親が別に実行・判定した。

記録は `.runtime/delegation/fable-read-task/acceptance.json`。相談・レビューは実行証拠の代替ではない。Fable は試験本体の全読解や現行 Swift の再読までは行っていないため、Native の状態整合性は親の読解と実機回帰を根拠にした。
