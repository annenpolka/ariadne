# Ariadne 実装計画

2026-09-20。README の P0–P4 を起点とする初期実装を完了。受入範囲、試験境界、残る適合課題は [development-status.md](development-status.md) に記録した。

## 目標と分担

`fill-fields.v1` について、意味による入力先の対応付け、固定操作、対象と値の事後検査、異常時の停止と引継ぎを一巡させる。

OpenCode の `opencode-go/deepseek-v4.1-flash` に Core 復旧と Swift Host の実装・レビューを委任した。親は共通インターフェース、受入条件、統合、実機検証を持つ。Jev Crosscheck は読解の補助に使い、確率をテスト成功に置き換えない。委任記録・request/response・実行証拠は gitignore 対象の `.runtime/` に保存する。

## 実施済み

- [x] P0: TypeScript strict の契約検証、fake Host、固定 Task / 操作、累積予算、状態機械、停止・結果・引継ぎ。
- [x] P0: 重複 commit、旧 epoch、対象変更、cancel、dispatch 前後の障害、応答喪失、実ファイル・再起動・排他制御の試験。
- [x] P1: Swift Host と AppKit fixture、stdio RPC、native ref、観測、prepare/commit/readback。
- [x] P1: 実 AX の11ケースで同名欄、disabled、登録ボタン、モーダル、要素交換、遅延中 cancel を検証。
- [x] P2: Jev 公式 SDK、質問コンパイル、回答検証、partial からの追加観測、一括 Binding と再利用。固定集合と実 AX 統合を実呼出しで確認。
- [x] P3: TextEdit の新規作業用文書を probe。本文の enabled が unsupported のため操作拒否を確認。入力成功の受入ではない。
- [x] P3 追加: 独立 Chrome プロファイルのローカル合成フォームで2欄入力・DOM oracle・URL変更後の拒否を実 AX で確認。
- [x] P4: CLI の observe/preview/execute/resume/replay/reevaluate、構造化した引継ぎ。
- [x] 評価: README 第15節の12シナリオを対応付け、独立 oracle、固定 seed の3方策比較、総時間とモデル時間を記録。
- [x] 仕上げ: 型、95件の通常試験、契約正例6件・負例22件、生成物、Swift build、実 AX 11件、実 Jev を確認し、手順と CI 定義を追加。

## 次の適合・拡張課題

- [ ] TextEdit の未取得属性を認可・鮮度判定で安全に扱える profile 設計と、実入力・読み戻しの受入。
- [ ] native 通知欠落の多様なパターン、実行中の権限変更、人間入力、別アプリの適合試験。
- [ ] 関連状態の進展を識別する失敗 fingerprint と、観測・prepare・dispatch・検証ごとの時間内訳。
- [ ] より広い独立評価集合と、fixture 以外の profile ごとの校正。
- [ ] GitHub CI の実行と専用 AX runner、配布署名・権限維持。

これらは初期実装の一般化・運用に必要な課題であり、完了したと主張しない。

## 維持する不変条件

Task revision と requiredChecks を実行中に変えない。Read/Model/Act を操作前に検査する。Host 内で確定した内容だけを commit する。dispatch intent の耐久記録が失敗したら操作しない。結果不明なら同一 ID の再実行も別 ID の変更も止める。完了には新しい観測と対象・値の証拠を要する。

外部 GUI の観測は best effort。exactly-once、未観測の副作用の不存在、意味 Binding の無誤りを主張しない。fixture の校正を一般実アプリの自動操作へ拡張しない。
