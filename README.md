# 食卓帳（meal-tracker）

写真1枚から料理名・カロリー・PFCをAI解析し、Googleスプレッドシートに自動記録するシステム。

- フロントエンド: GitHub Pages（`docs/index.html`、素のHTML/CSS/JS）
- バックエンド: Google Apps Script（`gas/Code.gs`）
- 画像解析: Gemini API（`gemini-2.5-flash`、マルチモーダル）
- データベース: Google スプレッドシート

## リポジトリ構成

```
meal-tracker/
├── gas/
│   ├── Code.gs           # GASバックエンド本体
│   └── appsscript.json   # マニフェスト（Webアプリ公開設定）
├── docs/
│   └── index.html        # GitHub Pagesで公開するフロントエンド
└── README.md
```

`docs/` を公開ルートにするのは、GitHub Pagesの設定で「Deploy from a branch」→「/docs」を選ぶだけで
リポジトリ直下を汚さずに公開できるためです。

---

## セットアップ手順

### ステップ1: スプレッドシートを準備する

新規スプレッドシートを作成し、URLからスプレッドシートID（`/d/` と `/edit` の間の文字列）を控えます。
シートとヘッダー行はGASが初回実行時に自動生成するので、手動でシートを作る必要はありません。

推奨カラム構成（自動生成されます）:

| 列 | 項目 | 内容 |
|---|---|---|
| A | 日付 | `yyyy-MM-dd` |
| B | 時刻 | `HH:mm:ss` |
| C | 料理名 | AIが推定した料理名 |
| D | カロリー(kcal) | 整数 |
| E | たんぱく質(g) | 小数1桁 |
| F | 脂質(g) | 小数1桁 |
| G | 炭水化物(g) | 小数1桁 |
| H | 画像URL | Driveに保存した場合のみ |
| I | 備考 | AIによる推定根拠・補足 |

### ステップ2: Gemini APIキーを取得する

[Google AI Studio](https://aistudio.google.com/apikey) でAPIキーを発行します（無料枠あり）。

### ステップ3: GASプロジェクトを作成し、claspでこのリポジトリと同期する

```bash
npm install -g @google/clasp
clasp login
```

新規にGASプロジェクトを作る場合:

```bash
cd meal-tracker/gas
clasp create --type webapp --title "食卓帳バックエンド"
```

これで `gas/` フォルダに `.clasp.json`（scriptIdが書かれたファイル）が生成されます。
既存のGASプロジェクトと紐付けたい場合は `clasp clone <scriptId> --rootDir ./gas` を使います。

`.clasp.json` はscriptIdのみを含み機密情報ではありませんが、個人のプロジェクトIDが分かるため
リポジトリには含めず `.gitignore` しておくことを推奨します（下記参照）。認証情報（`~/.clasprc.json`）は
ホームディレクトリに保存されるためリポジトリには一切含まれません。

コードを反映:

```bash
clasp push
```

### ステップ4: スクリプトプロパティを設定する

GASエディタ（`clasp open` で開けます）から
「プロジェクトの設定」→「スクリプト プロパティ」で以下を追加します。

| プロパティ名 | 値 |
|---|---|
| `GEMINI_API_KEY` | ステップ2で取得したAPIキー |
| `SHEET_ID` | ステップ1で控えたスプレッドシートID |
| `DRIVE_FOLDER_ID` | （任意）食事写真を保存するDriveフォルダID |

`GEMINI_API_KEY` を設定後、GASエディタで `testGeminiConnection` を実行すると
プロパティが正しく読み込めているか確認できます。

### ステップ5: Webアプリとしてデプロイする

初回デプロイ（GUIの場合）:
「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」を選択し、
- 実行するユーザー: **自分**
- アクセスできるユーザー: **全員**

として公開すると `.../exec` で終わるURLが発行されます。これが `GAS_EXEC_URL` です。

claspの場合:

```bash
clasp deploy --description "v1"
```

**コードを更新したとき**は、`clasp push` でコードを反映したあと、
既存のデプロイに対して新しいバージョンを発行することで `/exec` のURLを変えずに更新できます。

```bash
clasp deployments        # デプロイID一覧を確認
clasp deploy -i <デプロイID> -d "更新内容の説明"
```

（GASエディタの「デプロイを管理」→ 編集アイコン→「新バージョン」を選ぶ操作と同じことをCLIで行っています）

### ステップ6: フロントエンドにURLを設定する

`docs/index.html` の以下の行を、ステップ5で発行された `/exec` URLに書き換えます。

```js
const GAS_EXEC_URL = 'https://script.google.com/macros/s/xxxxxxxxxxxxxxxxxxxxxxxx/exec';
```

### ステップ7: GitHub Pagesを公開する

1. このリポジトリをGitHubにpush
2. リポジトリの Settings → Pages → Source で「Deploy from a branch」→ ブランチ `main` / フォルダ `/docs` を選択
3. 発行されたURL（`https://<ユーザー名>.github.io/meal-tracker/`）にスマホでアクセスして動作確認

---

## .gitignore（推奨）

```
node_modules/
.clasp.json
.claspignore
```

## GitHub Actionsで自動push（任意・上級者向け）

コード変更を `git push` するたびに自動で `clasp push` したい場合は、`~/.clasprc.json` の内容を
GitHub Secretsに登録してActionsから利用する方法もありますが、認証トークンをリポジトリのSecretsに置くことになるため、
個人開発の範囲では手元で `clasp push` → `clasp deploy -i` を手動実行する運用で十分です。
自動化する場合も、`/exec` のURLを固定したまま更新する `clasp deploy -i <デプロイID>` を
ワークフローの最終ステップに必ず含めてください。

---

## エラーハンドリングについて

- **画像から料理を認識できない場合**: Gemini側が `recognized: false` を返すよう指示しており、
  GAS側でエラーとして扱い、フロントエンドに「認識できませんでした」と表示して再撮影を促します。
- **Gemini APIエラー・タイムアウト**: HTTPステータスとレスポンス本文をそのままエラーメッセージに含めて返すため、
  Google AI Studio側のクォータ超過なども判別できます。
- **AIの応答がJSONとして壊れている場合**: 正規表現で `{...}` 部分を抽出して救済パースを試みます。
- **Drive保存の失敗**: 記録自体は継続し、画像URLのみ空欄になります（スプレッドシートへの記録を優先）。
