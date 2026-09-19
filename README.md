# Ariadne v0.1 — 実装に進むための設計案

作成日: 2026-09-20  
状態: **設計案。ランタイム・ネイティブホストは未実装**  
対象: 小目標を、観測で裏付けられた短い操作へ変換し、結果を検証する実行系

ローカル環境の準備と検証手順は [CONTRIBUTING.md](CONTRIBUTING.md) を参照。

## 0. この資料に含まれるもの／含まれないもの

この資料は、会話中のAriadne構想を具体化した提案である。ユーザーによる個々の仕様の承認、既存リポジトリへの反映、ネイティブ実装、実際のJev呼び出し、実機性能測定は行っていない。

同梱のJSON Schemaと例は、契約の形を確認するための小さい設計標本であり、ランタイム全体の完成したスキーマではない。`verify_contracts.py` は形と一部の参照整合性を検査する。観測の真実性、認可、対象の鮮度、クラッシュ復旧、GUIへの副作用は検査しない。例にあるトークン、成功記録、確率は架空のもの。ファイル群は、実機で採取した一つの連続トレースではない。

## 1. 事実として設計に使う前提

JevのChoice/Score/Noulは同じstateに対する型付きの質問であり、同一リクエストの質問は独立に評価される。質問IDは回答との対応付けのためのキーで、モデルへの指示ではない。[S1]

Choice/Scoreのconfidenceは選択肢の確率分布から導く統計量である。特定GUIタスクの成功率と同一視しない。公式にも、閾値は用途と実際の評価に依存すると説明されている。[S2]

Jev 1.13向けの注意事項には、数値精度、日時比較、多段参照、無関係なstate、敵対的な内容による回答誘導が含まれる。これは当該バージョンに関する公式の説明であり、将来のモデル全般の不変な性質を主張するものではない。[S3]

macOSのアクセシビリティモデルは、属性、アクション、通知、要素階層を提供する。ボタンを押した後のアプリの業務上の振る舞いを、アクセシビリティAPI自体が規定するものではない。[S4]

Windows UI AutomationのRuntimeIdも時間とともに再利用され得る。OSネイティブのIDを永続的な業務IDに昇格させない。[S5]

2026-09-20の公式リリース一覧ではNode.js 24系はLTS。TypeSafeはJavaScript/TypeScript SDKを提供している。[S6][S7]

以降はAriadneの**設計提案**である。

## 2. 初版のプロダクト契約

### 採用案

一つの操作ホスト、一つの対象アプリ／ウィンドウ、一つの実行中Taskに絞る。副作用を伴う操作は常に一件ずつ直列化する。最初の価値は「ラベルと所属から入力先を対応付け、指定値を入力し、対象と値の反映を確かめる」こと。

最初のレシピは `fill-fields.v1`。生成モデルは、目標の分解や不足入力の準備をする外側のSupervisorとして接続できるが、初版に独自の万能Plannerは作らない。ランタイムは、既知のレシピ内ではJevとコードで進み、レシピを外れたときには構造化した引継ぎを返す。

### 初版では扱わないもの

任意の座標クリック、任意キー送信、クリップボード、シェル実行、ブラウザ内の任意JavaScript、ログイン／パスワード入力、アプリをまたぐ作業、無人の高影響操作、ネットワーク越しの操作ホスト、自動的な永続レシピ学習。

これらを永久に排除するのではない。それぞれを別の明示的な能力として後から追加する。要素操作が失敗した際に、座標操作へ黙って落ちる経路は作らない。

### 名称

公開APIの主語は `Task`、`Observation`、`Operation`、`Evidence`、`Result`。`Binding` と `ObservationQuery` は内部の型として使う。

Ariadneの比喩は説明に使うが、`Task → Waypoint → Aria` の三重階層や、`Knot`、`Score`などへの全面改名は初版に入れない。`Score`はJevの既存プリミティブとも衝突する。

## 3. 責務境界

```text
Supervisor / CLI
  │ TaskSpec（目標、入力、要求する範囲、固定した成功条件）
  ▼
TypeScript Core
  ├─ task state machine
  ├─ observation selection / semantic question compilation
  ├─ binding / bounded recipe execution
  ├─ validation / budgets / evidence / trace
  └─ Jev provider（交換可能）
  │ versioned JSON-RPC over stdio
  ▼
Swift macOS Host
  ├─ operator-issued scope / grant validation
  ├─ native element references / observations
  ├─ prepare / immediate preflight / serialized dispatch
  ├─ durable dispatch journal
  └─ AX calls and notifications
```

CoreとHostは両方とも信頼する実装の一部。モデルの回答、アプリのラベル、アプリから得た文章は信頼済みポリシーではない。Hostを分離しただけで、悪意あるCoreや同一ユーザーの任意プロセスまで封じ込められるとは主張しない。

SkillやMCPは外側の入口にできる。停止、失効、重複抑止、検証はSkillの文章ではなくコードに置く。

## 4. TaskSpec：実行中にゴールポストを動かさない

Taskは `taskId` と `revision` で識別する。入力、目標、requiredChecks、要求範囲を開始時に固定する。Supervisorの変更は新しいrevisionとして受け取り、旧revisionの判断・未実行操作を失効させる。

Task内の `scopeRef` は既に発行された範囲への参照であり、権限の発行ではない。Taskの予算も要求値であり、実効値はoperator側上限との小さい方にする。

`fill-fields.v1` は、slotごとに意味、入力参照、必要なら所属領域のヒントを持つ。各slotに対する必須の値照合を一件ずつ要求する。未検証のslotが残っている状態を完了としない。

初版のチェックは登録済みの型だけとする。モデルが生成したJavaScript、任意のコールバック、動的な検証コードは受け付けない。同梱の小さいスキーマは `value_equals_input` のみを表現している。存在検査や別レシピは型と適合試験を追加してから公開する。

空の検査一覧を `every([]) == true` だから成功扱いする実装は禁止する。

## 5. Observation：事実・省略・不確実性を保持する

### 5.1 構造

観測は、取得元scope、sessionEpoch、観測ID、取得開始／終了の単調時計値、イベントシーケンス、取得範囲、ノードと親子関係を持つ。ノードは表示名、値、状態、操作能力を持つ。

roleはOS APIの識別子から正規化する。表示上の翻訳語をパースしてrole判定しない。元のnativeRoleも残す。対応のないroleは `unknown` とし、操作能力が確認できない対象を操作しない。

属性の結果は、少なくとも次を区別する。

- `available`：取得できた値。空文字列やfalseも正当な値。
- `unavailable`：今回は値が得られない。
- `unsupported`：属性自体が提供されていない。
- `redacted`：秘匿方針により省いた。
- `error`：取得に失敗した。

取得失敗を空文字列へ変換しない。比較時のUnicode正規化、空白除去、改行変換も黙って行わない。初版の文字列比較はexact。正規化比較が必要なら、検査種別に明示する。

### 5.2 完全性

`provider_exhausted` は「この問い合わせに対してproviderが列挙した範囲を取り切った」という意味であり、実アプリの全機能が見えているという意味ではない。仮想化された一覧、非公開要素、canvasなどの存在までは否定しない。

`partial` にはbudget、virtualized、unsupported、error、redactedなどの省略理由を付ける。切り詰めた候補を渡したまま「画面に該当対象は存在しない」と判定させない。

### 5.3 一貫性とID

AXの観測を勝手に原子的なスナップショットとして扱わない。初版のnative hostは `best_effort`。取得中に関連状態が変わった疑いがあればdirtyとして再取得する。通知がないことは不変の証明ではなく、実行前には必要な属性を読み直す。

要素参照はhostが発行するopaque ref。sessionEpoch、アプリ起動の世代、window、native handleと関連付ける。label、配列番号、座標を要素の同一性として使わない。

元の要素が消えた場合、新しく同名の要素を見つけても旧refを付け替えない。新しいBindingとOperationを作る。

### 5.4 観測窓

初版のObservationQueryは数種類のプリセットでよい。

`window_summary`、`active_dialog`、`editable_fields`、`element_context`、`changes_since`。

不足情報を取得する操作と、環境を変える操作を分ける。スクロールやメニュー展開は観測目的でもOperationである。

## 6. 意味判断：対象対応付けを中心にする

### 6.1 通常ルート

```text
Taskを検査
→ 成功条件を既に満たすか確認
→ 関係する領域を観測
→ コードで操作能力をフィルタ
→ slotごとに対象候補をJevで一括評価
→ Bindingの整合性をコードで検査
→ 一件ずつprepare / commit / readback
→ 必須条件を最後に再検査
```

欄を一度対応付けできれば、通常の入力値設定のために毎回Jevを呼ばない。後続欄に使うBindingは、所属・role・対象・モーダルなどの前提を毎回検査する。値だけを書き換えても前提が変わらないと確認できる場合に再利用する。

UIが変われば必要なBindingを破棄する。初版は過度に細かなキャッシュではなく、領域単位の保守的な失効で始める。不要な再判定率は計測する。

ただし、何が変わっても全Bindingを失効させる設計にはしない。依存を二つに分ける。

| 種類 | 代表的な依存 | 無効化するもの |
|---|---|---|
| 意味的な対応付け | 対象の同一性、role、名前、ラベル関係、所属領域、モーダルの関係 | Bindingと、それに基づく未実行操作 |
| 今回の操作前提 | 対象の現在値、enabled、必要なfocus、grantとcontrolの世代 | PreparedOperation |

一つの入力欄の値を更新しただけなら、他欄の所属や名前が変わっていないことを読み直して確かめ、他のBindingは利用できる。通知の原因が「自分の操作のはず」と推測するだけでは再利用しない。意味に関係する属性が変わった場合や変化を分類できない場合は、領域を再取得して保守的に判断し直す。

### 6.2 候補と探索

対象候補にはrole、名前、所属領域、関連説明、利用可能操作を直接添える。何段ものID参照をモデルに辿らせない。内部の正本はグラフでも、モデル入力は目的別に必要部分を展開したものにする。

選択肢には `need_more_observation` と `none_in_observed_scope` を含める。どちらも「アプリ全体に存在しない」ではない。

候補が多い場合は、まず領域を選び、次にその領域を取得する。あるいは取得済みの全チャンクを評価してから統合する。上位N件へのスコアリングだけで対象の不在を確定しない。

### 6.3 質問コンパイラー

質問は `templateVersion`、必要な証拠、選択肢、質問本体、Task revisionを持つ。質問IDだけに対象名や条件を置かない。[S1]

同じ材料で答えられる質問をまとめ、新しい観測が必要な質問は次の呼び出しへ送る。選択された具体的操作への審査が必要なら、先に操作案を具体化してから質問する。ただし、通常の既知の入力設定まで「対象判断＋汎用risk判断」の二回呼び出しを必須にはしない。認可済みレシピと決定論的検査で足りる部分をモデルへ戻さない。

判断はTask revision、sessionEpoch、questionSetVersion、入力stateのdigestに紐付ける。遅れて届いた旧判断は記録しても、新しい状況での操作許可には使わない。

### 6.4 回答検査

必要な質問が揃っているか、型が一致するか、選択肢が定義通りか、確率が有限で0〜1か、分布のキーが揃うか、合計が許容誤差内かを検査する。異常値を丸めて安全そうな回答へ変換しない。検証前にdoneだけを見て早期returnしない。

confidence、最大確率、二位との差、棄却選択肢の確率は記録する。ただし、複数質問の確率を独立とみなして掛け算しない。一律のconfidence閾値を安全性の証明として使わない。

初期閾値はモデル・質問セット・fixture別の評価で決め、設定に版を付ける。校正していないモデルを実アプリの自動操作で使用可能にしない。モデルIDを明示し、返されたmodel識別子も保存する。

## 7. PreparedOperation：検査したものと実行するものを一致させる

最初のcommandは `set_value(targetRef, value)` と `invoke(targetRef)`。後者は具体的に許可したアプリプロファイル／fixtureの操作に限定する。名前が無害そうなボタンなら自由に押せる、という契約ではない。

手順は次の通り。

1. CoreがBindingと正確な引数から操作案を構築する。
2. Hostがscopeとcapabilityを確認し、必要な属性を読む。
3. Hostが確定済みの内容とguardを保持し、`preparedId`を返す。
4. 必要な意味判断・認可を確定内容へ適用する。
5. `commit(preparedId)`で同じ内容を実行する。

commitには座標、別の文字列、別のtargetを追加できない。引数を変えるなら新しいprepareが必要。

最低限のguardはHostと登録済みprofileが決める。モデルが「この検査は不要」と宣言できない。guardにはsession／control epoch、Task revision、grant版、app起動の世代、window、対象、操作能力、必要な編集可能状態、関連するモーダル、上書き前の値などを含める。

操作ホスト内の確定内容が正本。JSON Schemaを通過しただけでは実行可能にならない。`preparedId`やdigestは認可そのものではない。

### 同一性と業務効果の限界

要素が同一でも、押した後に何が起こるかは別の問題。アプリプロファイルが既知の効果と検証手段を持つ範囲で自動実行する。

外部GUIでは、guardの再検査と実操作の間の競合を完全には消せない。Ariadneは、検出した変化では止めるが、外部GUIにatomic compare-and-actを実装できたとは主張しない。自前アプリでは、実行API側でexpectedRevisionを検証する強い契約を追加できる。

## 8. 実行記録・重複・停止

### 8.1 操作状態

```text
prepared
  ├─ expired / not_dispatched
  └─ dispatch_intent（durable記録）
       ├─ attempted → 事後観測・検査
       └─ outcome_unknown → 照会・照合・人への引継ぎ
```

`attempted` はAPI呼び出しが戻ったという実行レシートであり、Taskの成功ではない。未知のdriver errorが「副作用前の失敗」と分類できない場合は、結果不明へ寄せる。

### 8.2 at-most-onceの範囲

JSON-RPCのrequest IDは応答との対応付けに使い、独立した`operationId`を重複抑止に使う。

同一operationIdへの再送でOS操作を再実行しない。Hostは既存のレシート／状態を返す。副作用を起こす前にdispatch_intentを記録し、それがdurableにならなければ操作しない。

dispatch_intentとOS操作を原子的にcommitする仕組みは外部GUIにはない。その間のクラッシュも結果不明になり得る。実際には未実行だったケースで停止することを許容し、重複実行を避ける。

別のoperationIdを発行すれば同じ効果を重複させられるので、IDだけでは不十分。結果不明の操作があるTask／関連scopeでは、状態の照合または明示的な人の解決まで後続の変更を止める。

これはGUIのexactly-once保証ではない。ジャーナルの保存・同期・再読込は実装と障害試験が必要であり、この資料のJSON試験で検証したことにはしない。

### 8.3 再起動

Host再起動でsessionEpochを更新し、古いnative refとpreparedIdは無効化する。未確定のdispatch_intentは結果不明として扱う。自動的に操作を再開しない。

Taskの履歴・累積予算・未確定操作は再起動で消さない。手動resumeも、新しい観測から始める。完了済みcheckpointも現在の状態で確認する。

### 8.4 cancel

cancelは新しいdispatchを禁止し、未実行のprepared operationと古いmodel応答を失効させる。既にOS APIへ渡した操作や発生した副作用を取り消すものではない。

Hostは制御メッセージ受信とAX処理を分ける。キャンセルは制御世代を更新し、操作ワーカーはdispatch直前にも世代を確認する。それでも既に境界を越えた呼び出しは結果確認が必要。

Ariadne内の単独実行leaseは人間や他アプリの操作を排除しない。初版では明示的停止と検出できたfocus/window変化で譲る。あらゆる人の入力を確実に検知できるとは約束しない。

## 9. 検証：二種類の正しさを分離する

### 9.1 値が正しいことと、対象が正しいこと

間違ったメール欄に正しい文字列を入れて読み返しても、値照合は通る。事後検査にはBindingに使った対象と所属の確認も含める。

ただし、意味判断で選んだ対象を同じ意味判断だけで再承認しても、独立した正解判定にはならない。実アプリでのResultには、対象判断が `semantic` なのか、登録profile／operatorに基づくのかを残す。値検査がexactでも、対象の意味判断が証明済みになったとは言わない。

`verified_success` の意味は「固定した機械検査の契約を証拠付きで満たした」であり、自由文のあらゆる意味や未観測の副作用を証明した、ではない。

### 9.2 Result

`verified_success`、`completed_unverified`、`blocked`、`failed`、`cancelled`、`outcome_unknown`を区別する。

verified_successには、保存済みTaskのrequiredChecks全件のpass、新しい事後観測、根拠参照、未確定操作なしを要求する。Result自身が申告したrequiredCheckIdsを、元のTaskの代わりに信用しない。

初版では、モデルによる「できたと思う」だけではverified_successにしない。意味判断が必要な完了条件は、推定または未検証として返す。任意に別の文書や同名の新要素へ検証対象を替えない。

「送信ボタンを押していない」という操作履歴と、「どこにも送信されていない」という外部効果の主張も区別する。自動保存、入力イベント、別プロセスの挙動は、観測手段なしに不存在を証明しない。

## 10. 認可と情報送信

ReadGrant、ModelGrant、ActGrantを分離する。最初の観測前にReadGrant、外部送信前にModelGrant、prepareとdispatch時にActGrantを確認する。allowlistに一致するかをモデル問い合わせの後で初めて見る、という順序にはしない。

profileはoperatorが登録したコード／データであり、画面上の文章から生成した許可表ではない。Jevのrisk判定が低くても、未知の効果に権限を与えない。

「文字入力なら常に安全」「AXに出ているからローカルな変更」という分類をしない。最初はfixtureの既知の操作と、検証済みの実アプリprofileに範囲を限定する。

アプリ由来の文字列はモデルに対する攻撃的な内容を含み得る。[S3] 入力をデータとして区別する工夫とテストを行うが、それだけでprompt injectionが消えるとは主張しない。

初版では秘密値・ログイン操作を対応範囲に入れない。将来のsecret referenceを理由に、現在未実装の秘匿機構をあるものとして扱わない。

モードは次のように分ける。

- replay：保存済みの入力だけを使用。実機操作なし。
- observe：許可された実機観測だけ。モデル利用は別指定。
- preview：操作案まで作る。実行しない。モデル送信の可否は別設定。
- execute：登録されたscopeとprofile内で操作する。

## 11. 復旧ルールと暫定予算

対象の変化／消失は再観測へ。能力不足は別レシピかSupervisorへ。待ち時間不足は期限付きの事後観測へ。実行されたか不明なら再送ではなく照会へ。単に同じ操作を繰り返さない。

無進捗のキーには小目標、対象、command、関連状態の指紋を使う。無関係な時計表示が変わっても、同じ失敗を新しい状態として数え直さない。逆に状態が本当に進んだ場合は、操作文字列が同じだけでループ扱いしない。

初期開発用の仮置き値は、Taskあたり変更操作20件、意味判断12リクエスト、追加観測展開3回、期限120秒。同じ失敗指紋が2回なら、その経路を停止する。これらは性能測定結果でもSLAでもなく、設定可能な暴走防止上限。

モデルAPIの再試行、観測の再試行、副作用の再試行を同じretry関数に入れない。SDKの自動再試行も総期限・累積回数へ含める。古い状態に対する問い合わせを長く再試行するより、必要なら観測からやり直す。

プロンプトや自動ルーティングの閾値は、評価で調整する。安全境界・固定した成功条件・operatorの権限を、失敗件数を減らすために自動で緩めない。

## 12. 技術とプロトコル

CoreはTypeScript strict＋Node.js 24 LTSを採用案とする。[S6] Jevは公式の `@typesafe-ai/sdk` を薄いproviderに閉じ込める。[S7] lockfileと実行ログで依存・モデル・質問セットを追跡する。

macOS HostはSwift＋ApplicationServices。最初のfixtureは標準AppKitコントロールで作り、実際のAX経路で試す。[S4] AXのread-only、値設定可否、通知、無効な参照、タイムアウト、権限変更は実機probeの対象。

プロセス間はJSON-RPC 2.0を一行一JSONのUTF-8で運ぶ。[S8] stdoutはプロトコル専用、stderrは診断用。初版ではRPC batchとネットワーク待受を実装しない。上限サイズ、スキーマ版、不明なmethod、不明なenumを明確に検査する。

### 最小のHost method

| method | 役割 |
|---|---|
| host.hello | protocol/schema version、hostEpoch、利用可能な能力を確認 |
| session.open | operatorが選んだapp/windowと既存grantへ接続 |
| observation.capture | 許可範囲内のObservationQueryを取得 |
| operation.prepare | 正確なcommandとguardをHostへ保持 |
| operation.commit | preparedIdに対応する一件をdispatch |
| operation.status | 同一operationIdの記録済み状態を返す |
| session.cancel | controlEpochを更新し、後続dispatchを止める |
| session.close | native refと未実行prepared operationを失効 |

通知は変化のヒント。取りこぼし、順序、シーケンスの欠落を考慮し、通知だけで対象の鮮度を証明しない。

JSON Schema 2020-12を外部データ契約の正本にする案とする。[S9] TypeScriptの型、Swiftのdecoder、共有の受入／拒否fixtureを整合させる。Codableでdecodeできたことだけをスキーマや意味の検証と同一視しない。

初版からワークフローエンジン、graph database、plugin discovery基盤、汎用質問DSLは入れない。普通の関数と明示的な状態機械から始める。

## 13. 記録と再生

常に必要なのは、Task revision、scope、操作ID、preparedId、状態遷移、判定・検証の版、未確定状態。rawの画面本文や入力値を無条件に長期保存しない。

通常のmetadata traceと、明示許可したreplayable traceを分ける。秘匿した記録は完全再生できないことを明示する。秘密や低エントロピー値の単純hashを、匿名化として扱わない。

replayは二種類を区別する。

`exact replay`：記録した観測と判定応答で制御ロジックを再現する。

`reevaluate`：同じ観測を新しいモデル／質問へ渡して、意味判断の差を比較する。

どちらも、異なる操作をした世界を再現するものではない。反実仮想の操作評価には、操作に反応するfixtureか実アプリの独立試験が必要。

## 14. 実装順序と合格条件

### P0：Core契約＋fake host＋障害注入

モデルを使わず、重複commit、古いepoch、途中cancel、準備後の対象変更、dispatch前後のクラッシュ、応答喪失を試す。純粋な状態機械と不変条件テストを先に作る。同梱のJSON検査はこのP0全体の代わりではない。

### P1：Swift Host＋AppKit fixture

read-onlyから始め、次に値設定と既知のボタンを操作する。UIには同名の欄、日英ラベル、disabled、モーダル、動的な要素交換、通知欠落、遅延を入れる。

fixtureの正解状態や業務IDは試験ハーネスだけが読む。モデルに正解IDを渡してから正答率を測らない。実際のAX経路は早い段階で通す。

### P2：Jevによる対応付けと追加観測

レシピが同じでもラベル・順序・所属が変わるタスクを解く。対象が不明なときに関連領域を追加取得できることを確認する。対応付け済みの複数欄を、不要なモデル呼び出しを挟まず入力する。

### P3：実アプリprofile

TextEdit等で、ユーザーが用意した新規の作業用文書への入力・読み戻しを試す。ただしAXでの直接設定が可能かはprobeで確認する。未対応ならunsupportedとして止め、任意キー操作へ黙って落ちない。

「明示的な保存操作を出さない」と「アプリが一切永続化しない」は別である。実アプリprofileは効果と検証可能範囲を確認して登録する。

### P4：Supervisor接続と薄い利用インターフェース

blocked理由、最新の観測範囲、足りない情報、試した経路、未確定操作、残り予算を引継ぎとして返す。初版の再開は明示的に行い、制御ホストを不用意に常駐させない。

## 15. 評価

中心指標は、独立したfixture oracleで確認した無介入のタスク完了率。その上で、誤った成功報告、誤対象、モデルへの接管、人への割り込み、結果不明、無用な停止、成功／失敗を含む全試行の時間を分ける。

速度は観測、入力組立、API再試行を含む意味判断、prepare、dispatch、settle、検証を通して測る。モデルからヘッダーが返るまでの時間だけを全体速度と呼ばない。

同じタスク集合とseedで、exact labelの決定論的baseline、毎ステップ意味判断、一括Binding＋コード実行を比較する。ground truthをモデルに見せない。

### 必須シナリオ

| シナリオ | 必須の挙動 |
|---|---|
| 同名のメール欄が別フォームにある | 名前だけでなく所属から対応付ける |
| 対象が初回観測の外にある | 不在と決めつけず追加観測する |
| 準備後に別の要素へ置き換わる | 旧operationを実行しない |
| 古いmodel応答が遅れて届く | 現在の操作に使わない |
| 同じoperationIdが再送される | OS呼出しを増やさない |
| dispatch前後でhostが落ちる | 不明を保存し、自動再実行しない |
| キャンセルがdispatchと競合する | 未dispatchを止め、境界通過済みは結果確認する |
| 値取得が失敗する | 空値として照合しない |
| 結果は正しい値だが対象が違う | fixture oracleは失敗にする |
| モデルだけが完了と答える | verified_successにしない |
| 無関係な時計表示が変わる | ループ抑止をリセットしない |
| アプリ内容が権限拡張を要求する | 既存scope／grantを変更しない |

schema/型の不変条件は通常のCIに入れる。AX適合試験はMac環境で別ジョブにする。再生テスト、fault injection、実機試験を別物として報告する。

## 16. 現時点で固定しないこと

Jevの実用閾値、最適なstateサイズ、AXのアプリ別対応、イベント通知の品質、Input Monitoringなしでどこまで人の介入を検知できるか、実機待機時間、Swiftホストの配布／署名／権限維持は実測対象。

APIの境界をこれらの測定待ちにする必要はない。低confidence、unsupported、timeout、partial observation、human interventionを受け止める戻り値は今決めておく。

Runeweaveなど自前環境ではatomicな操作契約を持てる可能性がある。外部GUIのbest_effortへ合わせて強い能力を弱めず、将来capabilityとして公開する。Warden等との共有は、この契約が二つの実装で実際に共通になったところから抽出する。初版から巨大な共通基盤は作らない。

## 17. この設計の中心

**意味判断によって対象を見つけ、確定した操作を実行し、決めてあった条件で結果を確かめる。その間に分からなくなったことを、分かったことにしない。**

それが回る小さな縦切りを先に作る。柔軟性は、APIの抜け道ではなく、追加観測・別のBinding・別のレシピで増やす。

## 参考にした一次資料

以下は設計時に参照した資料であり、Ariadneの実装結果を裏付けるものではない。

[S1] TypeSafe, Primitives (Questions): `https://docs.typesafe.ai/primitives`  
[S2] TypeSafe, Confidence: `https://docs.typesafe.ai/confidence`  
[S3] TypeSafe, Jev 1.13 jaggedness: `https://docs.typesafe.ai/model-jaggedness/jev-1.13`  
[S4] Apple, The OS X Accessibility Model（アーカイブ資料）: `https://developer.apple.com/library/archive/documentation/Accessibility/Conceptual/AccessibilityMacOSX/OSXAXmodel.html`  
[S5] Microsoft, AutomationElement.GetRuntimeId: `https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.getruntimeid`  
[S6] Node.js Releases: `https://nodejs.org/en/about/previous-releases`  
[S7] TypeSafe JavaScript SDK: `https://docs.typesafe.ai/sdk/javascript`  
[S8] JSON-RPC 2.0: `https://www.jsonrpc.org/specification`  
[S9] JSON Schema 2020-12: `https://json-schema.org/draft/2020-12`  
[S10] TypeSafe HTTP API: `https://docs.typesafe.ai/api`

## 同梱ファイル

`contracts.schema.json`：Task、Observation、PreparedOperation、HostReceipt、TaskResult、Decisionの設計標本。  
`examples/`：架空の有効データと、送信していないJevリクエストの例。  
`verify_contracts.py`：スキーマと一部の参照関係の正例・負例検査。  
`validation-results.json`：契約検証の実行結果（再実行で更新）。  
`build_contracts.py`：スキーマ・例の生成元。

再実行にはPython 3.11以上とuvが必要。`uv.lock` に固定した依存を使う。

```sh
make setup
make check
```
