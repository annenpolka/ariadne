# Ariadne の作業ガイド

- 作業前に `README.md` と `CONTRIBUTING.md` を読む。`Jev-Cu解説.md` は構想の履歴であり、現在の設計案と照合する。
- 現在は初期実装と専用 fixture の検証段階。実装や検証の完了を述べるときは、存在するコードと実際に通した経路を根拠にする。
- 契約を変えるときは `build_contracts.py` を編集し、`make generate` と `make check` を実行して、生成物もレビューする。JSON を直接編集したまま生成元との不一致を残さない。
- `make check` が検査するのは JSON の形と一部の参照整合性。P0 の状態機械試験、モデル呼び出し、実機 AX 適合試験とは分けて報告する。
- 未完了の実装・評価は docs/development-status.md と README の P0–P4 を照合する。Core は TypeScript strict、操作ホストは Swift という設計案を参照する。
- Task の固定した成功条件、意味判断と認可の分離、確定済み操作と実行内容の一致、結果不明時の重複実行抑止を保つ。
- `.env`、認証情報、実画面・入力値を含むローカルトレースはコミットしない。架空の例と実行証拠を区別する。
- deep-research レポートは、別の指定がなければ `~/Mechachang/raw/` に Mechachang 側の命名規則で保存する。
