# 読み取り予算の実測と変更

2026-09-20。旧値の2,048要素・観測512 KiB・結果1 MiBでは、一般的な資料ページでも途中で切れていた。ページ全体の規模を測ってから既定値を増やし、増量で露呈した通信と探索のコストも修正した。変更は未コミット・未プッシュ。

## 現行値

| 予算 | 旧既定値 | 新既定値 | 明示指定できる最大値 |
|---|---:|---:|---:|
| 1回の観測ノード | 2,048 | 32,768 | 65,536 |
| 観測 JSON | 512 KiB | 16 MiB | 32 MiB |
| 探索の深さ | 64 | 128 | 256 |
| 1回の取得時間 | 3秒 | 10秒 | 20秒 |
| 抽出結果の record | 2,048 | 32,768 | 65,536 |
| 証拠付き結果 JSON | 1 MiB | 64 MiB | 128 MiB |

セッション全体は既定10回・60秒を維持する。10回×10秒を保証するものではなく、期限に先に達すればそこで止まる。取得時間は前後の文書同一性確認を含む。実行中の AX 呼出しを厳密に中断できる保証はなく、直列化・RPC・Core の検証時間も別途かかる。

上限は必要になった分だけ使い、最大容量を事前確保しない。CLI は新既定値を使い、上回る値は明示オプションが必要。ReadSessionSpec は operator grant の ceiling を超えられない。新しい値でも `partial` を成功扱いせず、全件取得や意味的な項目抽出を保証しない。

正本は `build_contracts.py` の READ_RANGES / READ_DEFAULTS / PROJECTION_RANGES / PROJECTION_DEFAULTS。JSON Schema と TS・Swift の定数を `make generate` で同時に生成する。従来の操作 Task の観測2,048要素と RPC 1 MiB は維持し、Task capture が read-session 用 Observation を返すことも拒否する。

## 見積もりの方法

Apple M4 Max、物理メモリ128 GiB、Node 24.18.0 arm64、実 Chrome と macOS Native AX で測定した。観測を一回取得し、証拠付き結果を作成・検証する経路を使った。CLI の起動・ページ読み込み・ログイン時間は下表の取得時間に含めない。

公開資料3件と合成の一覧・深い構造を、既定値と明示最大値で各3回測定した。worker をケースごとに別プロセスにして Node のピーク RSS を分け、Host は `/usr/bin/time -l` で計測した。Chrome 自体のメモリは除外する。画面本文を成果物に保存せず、件数・サイズ・時間・状態を記録した。

以下は512件単位の取得へ変更した後の3回測定。末尾の短い AX 応答への修正後にも、同じ9ケースを各モード1回と production CLI で再確認した。3回の最大値を p95 や他機種の性能保証とは扱わない。

| ケース | 観測ノード | 観測 / 結果 MiB | 取得時間の範囲 | 結果 |
|---|---:|---:|---:|---|
| W3C 表の説明ページ | 743 | 0.21 / 0.45 | 122–126 ms | 既定値で provider_exhausted |
| MDN ARIA roles | 2,477 | 0.71 / 1.50 | 381–387 ms | 既定値で provider_exhausted |
| RFC 9110 全文 | 22,161 | 6.59 / 13.60 | 3,230–3,254 ms | 既定値で provider_exhausted |
| 合成5,000行 | 10,002 | 3.33 / 6.50 | 1,481–1,519 ms | 既定値で provider_exhausted |
| 合成15,000行 | 30,002 | 10.01 / 19.52 | 4,763–4,787 ms | 既定値で provider_exhausted |
| 合成32,767行 | 65,536 | 21.89 / 42.67 | 11,914–12,376 ms | 明示最大値で provider_exhausted |

RFC の規模に対し、既定値はノード約1.5倍、観測サイズ約2.4倍、結果サイズ約4.7倍、取得時間約3倍。3万ノードの一覧も通常の既定値で収める。実ページの最大深さは14だったため既定128に余裕があり、深さ256は明示最大値で境界を検証した。深さ202の合成ページは既定128では partial になる。

最終コードでの単回再確認は、既定値で RFC 3,266 ms、3万ノード4,826 ms、明示最大値で65,536ノード12,806 msだった。いずれも予算による省略はない。既定値での大きすぎるページ・深さと、16/32 MiBの境界は引き続き partial を返す。深さ256の参照を使う再読取も通った。

65,536ノードの画面は既定32,768ノードで partial。16,000文字×1,000段落の長文ページは、既定で16,776,899 bytes、明示最大値で33,554,243 bytesまで読み、上限により partial/redacted を返した。設定を増やした結果、不足を隠して provider_exhausted にする経路は作っていない。

## メモリと対応限界

3回測定のピーク RSS は、RFC で Host 約421 MiB・Node 約479 MiB、3万ノードで約722 MiB・689 MiB、65,536ノードで約1,551 MiB・992 MiBだった。後者は2つのピークの合計で約2.5 GiB。各プロセスが同時にそのピークに達したという測定ではない。最終コードの単回再確認では、それぞれ約200/437 MiB、426/524 MiB、902/868 MiBだった。試行数とソースが異なるため、減少率を性能改善の証拠とは扱わず、見積もりには大きい方を残す。

JSON の上限はプロセスのメモリ上限ではない。AX 要素、JSON オブジェクト、凍結コピー、検証用の一時データがあるため、本文サイズより大きいメモリを使う。この Mac で OOM が起きなかったことを、低メモリ端末での保証にしない。65k ノードと最大長の全属性が同時に存在する組合せ、参照 registry が262,144件まで増えた状態、長時間稼働は別の評価が必要。

観測範囲を減らす場合は `--max-nodes`・`--max-bytes`・`--max-depth`・`--max-capture-ms`、結果を減らす場合は `--max-records`・`--max-output-bytes` を指定する。AX に公開されない内容、仮想化・frame、ページ更新中の一貫性は予算だけでは解決しない。

## 数値以外の変更

- Read RPC の応答上限は観測予算＋64 KiB、timeout は max(15秒, 取得予算＋5秒)。明示した通信上限・timeout を上書きしない。
- RPC の途中データは chunk として保持し、一つの行が完成したときに一度結合する。各 chunk 到着時に全体をコピーし直す処理をなくした。
- 抽出・検証の属性引用は保持した node を直接参照する。全ノードから `find` を繰り返す処理をなくし、凍結した Task/Observation の digest は一度計算する。root 到達済みの経路も再利用する。
- Native の封筒サイズ見積もりは固定の2,048ではなく、要求 maxNodes を使う。参照 registry の上限は硬いノード上限の4倍、領域の祖先確認は深さ256の親まで到達できる範囲にした。
- 子要素の ranged AX 読み取りを最大64件から512件にした。wanted・残時間・不正要素の計数・frame 除外・権限は維持する。
- provider が要求数より少なく返した場合は実件数分だけ進む。途中の空応答を完全列挙とせず、要求より多い応答を拒否する。実際のループに短い応答を注入して、順序と要素の保持、途中終了、上限を検査した。

512件への変更前は、65k ノードの幅広ページで子一覧の取得に時間を使い切り、20秒でも2〜3万ノード、10秒ではrootとsectionだけになる例があった。変更後は手動最大値で65,536ノードを約12秒で取り切った。この差にはページ・provider の状態も影響するため、全サイトが同じ倍率で速くなるとは扱わない。

## 証拠と再現

- 当初候補16,384要素・8 MiB・5秒では RFC が切れた記録：`.runtime/browser-budget-measure-nXu4Xg/report.json`。
- 最終既定値にして64件取得のまま測定した記録：`.runtime/browser-budget-measure-9iBACX/report.json`。
- 512件取得の3回測定：`.runtime/browser-budget-measure-ORlGMm/report.json`、最大値は `.runtime/browser-budget-measure-TKr0bW/report.json`。各ディレクトリの frozen.json に測定中のエンジン SHA256 を保持する。
- 65k ページの初回は読み込み中の文書変更で stale_binding を返した。`.runtime/browser-budget-measure-NxxtOq/report.json` を残し、合成ページの load と描画を確認してから測定するようハーネスを修正した。Host の失効判定は緩めていない。
- 短い AX 応答の修正後の最終再確認は `.runtime/browser-budget-measure-2uNFzU/report.json`、`.runtime/browser-budget-measure-ZEZkZQ/report.json`。いずれもエンジン32ファイルの SHA256 が最終ソースと一致し、production CLI も確認した。標準出力は `.runtime/browser-budgets-normal-recheck.txt`、`browser-budgets-stress-recheck.txt`。既存の実機回帰は同じ接頭辞の read-regression / extract-regression / native-regression に記録した。

最終受入の集計は `.runtime/browser-budgets-acceptance.json`。型検査・build、通常138件、Swift単体8件、実 Chrome 読取15項目・抽出7項目、Native AX操作fixture11シナリオが成功した。契約の再生成で生成物に差分がなく、JSON正例10件・負例38件も成功。JSON検査単独を実機検証とは扱わない。

ログイン済み専用 Chrome の Calendar も、変更後の既定値で592レコード、provider_exhausted、outputTruncated=falseを確認した。これは AX ノード属性の引用件数で、予定件数ではない。modelCalls=0・operations=0、未解決操作なし。`.runtime/browser-budgets-calendar-final.txt` に件数・状態だけ保存し、予定本文・認証情報は保存も委譲もしていない。

再現は `npm run test:browser-budget` と `npm run test:browser-budget -- --stress-only`。既定では各3回、`--single` は修正後の単回再確認用。最大値の計測だけ session を120秒とし、20秒×3回と後処理を収める。通常 CLI の既定60秒は変更しない。

## Fable の相談と親の判断

[claude-code-delegate](https://github.com/annenpolka/skills/tree/main/claude-code-delegate) を使用し、同じ session `e76f6b13-ee38-431e-a339-fb70ac20bb43` を再開した。指定 alias は fable、実モデルは claude-fable-5-1。Read/Glob/Grep のみ、default permission mode、safe-mode、strict-mcp-config、no-chrome。渡したのはソースのコピーと公開・合成測定の集計で、Calendar の画面値や profile、認証情報は渡していない。

Fable から RPC の上限、受信コピー、最悪時間、registry、短い ranged AX 応答、未測定の硬い最大値について指摘を得た。最大値の追加測定と短い応答の修正を実施した。一方、「前後のidentityをcapture clockに足す」「安定した同じ文書でも毎回registryが増える」という説明は現行コードと合わず、親が訂正した。所見をそのまま採用せず、ソース・反例・実機の結果で判定している。

相談記録は `.runtime/delegation/fable-read-budgets/`。3回とも指定モデル・default permission mode・許可した3ツールのみで成功し、権限拒否・MCP接続・委譲側のファイル変更はなかった。最終コピー85ファイルのハッシュも一致した。`acceptance.json` に確認結果を保存した。短い AX 応答の最終修正はレビュー後に親が実施・検証した。Fable 自身は実機試験をしていない。実装・統合・受入は親が行い、JSON 検査、通常テスト、Swift 単体、実 Chrome / AX の結果を区別する。
