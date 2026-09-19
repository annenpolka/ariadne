# 開発準備

現在のリポジトリには、設計書、JSON 契約の標本、架空の例、生成・検証スクリプトがある。Core、fake host、Swift Host は未実装。

## 読む順序

1. [README.md](README.md)：現時点の設計案。特に責務境界、契約、実装順序と合格条件を確認する。
2. [Jev-Cu解説.md](Jev-Cu解説.md)：構想に至る会話と調査の記録。過去の案やリンクを含むため、現在の設計は README と照合する。
3. `build_contracts.py`、`contracts.schema.json`、`examples/`、`verify_contracts.py`：設計をデータとして表現した範囲と、検証の限界を確認する。

## ローカル検証

Python 3.11 以上と uv を使用する。Python の設定は既存の契約ツール用であり、Core の言語を変更するものではない。依存バージョンは `uv.lock` に固定する。

```sh
make setup
make check
```

`make setup` は `.venv/` を用意する。`make check` は契約の正例6件と負例22件を検証し、`validation-results.json` を更新する。初回の環境構築・依存取得にはネットワークが必要になるが、検証スクリプト自体はモデル API やデスクトップ API を呼ばない。

make を使わない場合は、`uv sync --locked` と `uv run --locked python verify_contracts.py` を実行する。

2026-09-20 の初回検証は、uv が選択した Python 3.12.13 の `.venv/` と、lockfile の jsonschema 4.26.0 で実行し、28件すべてが想定どおり受理・拒否された。

## 契約を変更するとき

`build_contracts.py` が同梱スキーマと7件の例の生成元。変更時は生成元を編集し、再生成した JSON と合わせてレビューする。

```sh
make generate
make check
git diff --check
git diff -- build_contracts.py contracts.schema.json examples/ verify_contracts.py validation-results.json
```

`make generate` は `contracts.schema.json` と `examples/*.json` を上書きする。例だけを直接編集してから実行すると、その編集は失われる。JSON Schema は外部データ契約の定義であり、Python のフィールド間検査はその一部を補う。

スキーマ・参照整合性の検査成功を、認可、状態機械、クラッシュ復旧、Jev の実応答、実機 AX 操作の検証済みという意味に広げない。`examples/jev-request.example.json` は送信していないリクエスト例で、6件の契約正例には含まれない。

## 次の実装単位

README の P0 から始める。TypeScript strict の Core 契約、モデルを使わない fake host、状態遷移と障害注入が対象。重複 commit、古い epoch、途中 cancel、準備後の対象変更、dispatch 前後のクラッシュ、応答喪失を受入条件にする。

設計案の Core 実行環境は Node.js 24 系。2026-09-20 の準備時点で、ローカルの既定環境は Node.js 26.0.0、Python 3.14.5、Swift 6.3 だった。Core 着手時には Node.js 24 系を用意し、パッケージ管理と lockfile を導入する。今回整えた Python 検証に Node.js は不要。

P1 で Swift Host と AppKit fixture の実際の AX 経路、P2 で Jev、P3 で実アプリ profile、P4 で Supervisor 接続へ進む。詳細と合格条件は README の第14・15節に置く。
