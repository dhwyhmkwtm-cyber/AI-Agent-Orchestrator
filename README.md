# AI Agent Orchestrator

複数のAIエージェントを連携させ、タスクを効率的に管理・実行するためのオーケストレーションツールです。

専門分野ごとに役割を持つAI(情報収集・市場調査・データ分析・商品企画・文章・ビジュアル・Web制作・品質検証)が、
統括ディレクターの立てた計画に沿って作業し、互いの成果をレビューして修正を重ねます。
重要な意思決定・外部公開・費用が発生する操作は、人間が iPad などのブラウザから最終承認します。
プロジェクトは「事業」ごとにまとめられ、全体画面で事業ごとの進み具合・承認待ち・今月の費用を一覧できます。

```
目的を入力 → 統括ディレクターが計画 → [人間が計画を承認]
  → 各専門AIが実行 → 別の役割がレビュー → 不合格なら原因分析して修正 → 再レビュー
  → 公開・費用発生を伴う成果は [人間が承認] → 完了
```

## 必要なもの

- Node.js 22 以上
- Claude Code を動かすための認証(`ANTHROPIC_API_KEY` など)。デモモードでは不要です。

## 使い方

```bash
npm install

# APIを呼ばずに画面と流れを試す(デモ)
npm run demo

# Claude Code で実際に動かす
ANTHROPIC_API_KEY=... npm start
```

起動するとダッシュボードのURLが表示されます(`http://127.0.0.1:8787/login?token=…`)。
このURLを開くとログインされ、以降はトークンなしで使えます。

### iPad から見る

同じネットワークの iPad から開くには、外部から接続できるように起動します。

```bash
HOST=0.0.0.0 DASHBOARD_TOKEN=長いランダムな文字列 npm start
```

表示された `http://<PCのIPアドレス>:8787/login?token=…` を iPad の Safari で開きます。
ホーム画面に追加するとアプリのように使えます。
インターネット越しに使う場合は、HTTPS 化と認証を備えたトンネル(Tailscale、Cloudflare Tunnel など)を経由させてください。

## 設定(環境変数)

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 待ち受けアドレス |
| `DASHBOARD_TOKEN` | 起動ごとにランダム | ダッシュボードのログイントークン |
| `PROVIDER` | (役割ごと) | `mock` にすると全役割をモックで動かす |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Claude Code が使うモデル(役割定義の `model` が優先) |
| `MAX_PARALLEL` | `2` | 同時に動かすタスク数 |
| `MAX_ATTEMPTS` | `3` | 人間に判断を仰ぐまでの修正回数 |
| `MAX_REVIEWERS` | `2` | 1タスクあたりのレビュー担当の上限 |
| `COMMAND_PROVIDERS` | なし | CLI型エージェントの追加(下記) |
| `DATA_DIR` / `WORKSPACE_DIR` | `data/` / `workspaces/` | 状態の保存先 / 成果物の作業場所 |

### 他のAIサービスとの連携

`src/providers/types.ts` の `AgentProvider` を実装すれば、どのAIサービスでも役割の担当にできます。
CLI で動くエージェント(Codex CLI など)は、設定だけで追加できます。

```bash
COMMAND_PROVIDERS='{"codex":{"command":"codex","args":["exec","-"]}}' npm start
```

追加したプロバイダは、`src/roles/catalog.ts` で役割の `provider` に指定します。
コマンドと引数は、使うCLIのドキュメントに合わせてください。
CLI型ではツール単位の承認を挟めないため、CLI側のサンドボックス設定で外部公開や費用の発生する操作を禁止してください。

## 費用の目安と調整

AIを呼び出すたびに、作業ログに費用と累計が記録されます。費用を左右するのは主に次の4つです。

- モデル: 既定は Opus 5.5(品質優先)。役割ごとに `src/roles/catalog.ts` の `model` で Sonnet などに変更できます。
- 思考レベル(effort): 既定は `medium`。役割ごとに `effort` で変更できます。
- レビュー担当の人数(`MAX_REVIEWERS`)と修正回数の上限(`MAX_ATTEMPTS`)
- プロジェクトの予算と事業の月予算: 達すると止まり、続行するかどうかを人間に確認します。

## 開発

```bash
npm test         # テスト(APIは呼ばない)
npm run typecheck
```

設計の詳細は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) を参照してください。
