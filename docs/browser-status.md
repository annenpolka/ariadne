# 独立 Chrome プロファイルでの実 AX 試験

2026-09-20。Google Chrome 153.0.8010.50 を空のユーザーデータ用ディレクトリで起動し、Ariadne の AX 入力経路を確認した。コードは `codex/implement-runtime` 上で未コミット・未プッシュ。

## 結果

`npm run test:browser` が成功した。専用 localhost ページ上の「連絡先」「配送通知先」にある同名のメール欄へ、それぞれ指定値を入力した。Core の読み戻しは `verified_success`、ページ側の DOM oracle も一致。dispatch intent は2件、Submit は0回。無効欄・パスワード欄・ブラウザ側の group への操作、無効な URL と別ページへの接続を拒否した。

prepare 後に `history.pushState` でタイトルを変えず URL を変更したところ、commit は `not_dispatched / precondition_changed` となり、入力値を変更しなかった。各試験は新しい profile と PID を使い、終了時に自分で起動した Chrome と localhost サーバーだけを停止した。

| 証拠 | 保存先 |
|---|---|
| 成功した実ブラウザ試験 | `.runtime/browser-OJN8ra/report.json` |
| Chrome の版・PID・専用 profile・起動引数 | 同ディレクトリの `launch.json` |
| 観測・Core の結果 | `observation.json`、`result.json` |
| 独立したページの値 | `oracle-after-input.json`、`oracle-after-navigation.json` |
| 通常テスト95件成功 | `.runtime/browser-core-tests.txt` |
| 既存の実 AX 11件成功 | `.runtime/native-acceptance-0f8f9814-904d-47b2-94ca-e340e7bd0a71/report.json` |

TypeScript typecheck/build と Swift build も成功。JSON の6契約と生成物は変更していない。GitHub CI は実行していない。

## 通常ウィンドウでの実行

同日、`npm run test:browser -- --demo` を実行した。app モードではなく、専用 profile の Chrome 通常ウィンドウで「連絡先」に `aria@example.invalid`、「配送通知先」に `delivery@example.invalid` を AX 入力し、Core と DOM oracle の両方で一致を確認した。操作 Host は終了している。確認用の Chrome とローカルサーバーは専用 Chrome の終了まで残す。

証拠は `.runtime/browser-OIEix6/report.json`、`result.json`、`oracle-after-input.json`、`window.json`。通常ウィンドウのタイトルには Chrome の文字列が付くため、ハーネスは起動した専用 PID の AXDocument が完全一致するウィンドウを特定し、その実際のタイトルを Host に渡す。Host のタイトル照合条件は維持した。最初のタイトル不一致は `.runtime/browser-PU0kPe/` に保存した。この demo 実行では URL 変更試験は行っていない。

## 実装した境界

登録 profile は `ariadne.chrome_fixture`。Host は operator が渡す PID、Chrome の bundle / executable、window の名前と native identity、ポート付き `http://127.0.0.1:PORT/path` の完全一致を検査する。window 内の WebArea が一つで、探索が完了していることを要求し、query・fragment・userinfo・複数 frame・不完全な探索を拒否する。

操作は、その WebArea 内で値取得・値設定・enabled を確認できる非秘密の AXTextField / AXTextArea に限る。Host はブラウザの起動、キー入力、ブラウザ内スクリプト、Submit を実行しない。ページに組み込んだ固定の試験用スクリプトは DOM oracle と URL 変更を担当し、Host の操作には使用しない。

試験の `--user-data-dir` は毎回新規作成し、実際の起動引数との一致も確認した。sync と拡張機能を無効にし、既存 profile は参照・コピーしない。これはユーザーデータの分離であり、OS アカウントやネットワークを分ける隔離環境ではない。記録と profile は `.runtime/` に残り、コミット対象外。

## 実測で見つけた修正点

- 当初はパスワード欄を redacted にしても capability を再付与していた。実 AX の拒否試験が検出し、native の設定可否と秘密欄判定を維持するよう修正した。
- Chrome は AXChildren にない AXScrollArea を AXParent に含めた。`.runtime/browser-n9cd1B/lineage.json` で、メール欄の親経路にこの一段が加わることを確認した。見えている子ツリーと、観測時の native 親経路を分けて保持し、prepare / preflight では元の native 親経路の ID・role・name を比較する。
- WebArea の AXURL だけを使った最初のガードは、history.pushState の試験を通過させた（`.runtime/browser-FOUxuN/`）。現在は window の AXDocument も必須で再確認する。同じ試験が操作を拒否することを確認した。AX の更新時刻すべてが原子的になるという保証ではない。
- WebArea 探索が子の取得エラーを無視する読解上の反例も修正し、部分的な探索で一意性を認めないようにした。

## 委譲と Jev 読解照合

[opencode-delegate](https://github.com/annenpolka/skills/tree/main/opencode-delegate) で指定モデル `opencode-go/deepseek-v4.1-flash`、session `ses_f43e0eb65ffeJR5ZihjqwbnnOb` を使用した。限定した Swift ソースを委譲し、親が試験ハーネス、CLI、上記の実測修正と最終受入を担当した。2回の relay はともに正常な終了 step を捕捉できず `failed`。記録は `.runtime/delegation/browser-profile/run/` と `repair/`。正常終了の報告として扱わず、受入は実行結果に基づく。

[jev-crosscheck](https://github.com/annenpolka/skills/tree/main/jev-crosscheck) は helper exit 0、返却モデル `jev-1.13.0`。`.runtime/jev/browser-review.*` と `browser-final-review.*` に request/response を保存。送信したのは許可済みソース断片で、ブラウザ profile・実画面・入力値・認証情報は含めない。実入力の対象決定は exact label provider であり、ブラウザ向け Jev 校正は行っていない。

最初の state は `page_url`、`attribute_helpers`、`web_area`、`identity`、`capture`、`prepare_rules`、`preflight`（Contracts.swift / AX.swift / Host.swift の対応部分）と `test_contract`。Noul の exact_url 0.94、incomplete_tree 0.96、secret_capability 0.94、field_membership 0.97。source は url_source 0.77、tree_source 0.97、secret_source 0.90。直接読解と実 AX の拒否試験を併用した。navigation_guard は0.85、identity_source は0.83だったが、上記の history.pushState は反例になった（counterexample found by execution）。

最終 state は `capture`、`live_ancestry`、`identity`、`web_area_initialization`、`observation_storage`、`prepare_comparison`、`preflight`、`url_helpers` の各ソース。native_chain 0.95、comparison_retained 0.96、window_url 0.95、commit_url 0.97、材料の十分さは chain_source 0.90 / url_source 0.89。確率を合否には使わず、親が ancestry 比較と AXDocument の呼出しを読み直し、同じブラウザ試験の成功を確認した（confirmed by reading / execution）。

## 範囲

これは専用 localhost フォームと、この Chrome 版での実行結果。ログイン済み Google Calendar の読み取りは、別の Read のみの profile で検証した（[calendar-status.md](calendar-status.md)）。任意サイトの操作、他のブラウザ、埋め込み frame、全ての人間介入は未検証。AX の観測と dispatch の間には best effort の競合が残る。一般ブラウザ向けの自動操作や誤対象の不存在を保証するものではない。

起動方法は Chromium の [独立データディレクトリ](https://www.chromium.org/developers/creating-and-using-profiles/) と [Accessibility 技術資料](https://www.chromium.org/developers/design-documents/accessibility/) を参照した。対応可否と数値は上記の自前実行記録に基づく。
