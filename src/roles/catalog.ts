import type { RoleDefinition } from '../core/types.ts';

// 専門AIの標準ロスター。provider を書き換えれば役割単位で別のAIサービスに差し替えられる。
// director(計画)と qa_reviewer(品質検証)はオーケストレータが必ず使う。

const READ_ONLY = ['Read', 'Glob', 'Grep'];
const WRITE = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
const WEB = ['WebSearch', 'WebFetch'];

export const DEFAULT_ROLES: RoleDefinition[] = [
  {
    id: 'director',
    name: '統括ディレクター',
    mission:
      'プロジェクトの目的を達成するために作業をタスクに分解し、最適な専門AIに割り当て、レビュー担当と承認が必要な箇所を決める。',
    criteria: [
      '各タスクは1つの役割で完結し、完了条件が具体的である',
      '依存関係が正しく、並行できる作業は並行できる',
      '外部公開・費用が発生する操作・重要な意思決定を含むタスクには必ず承認を設定する',
      '各タスクに、成果物の領域を理解している別役割のレビュアーを付ける',
    ],
    provider: 'claude-code',
    tools: [...READ_ONLY, ...WEB],
  },
  {
    id: 'researcher',
    name: '情報収集',
    mission: 'インターネット上の情報を収集し、出典付きで整理する。',
    criteria: [
      'すべての主張に出典URLと取得日を付ける',
      '一次情報を優先し、二次情報の場合はそう明記する',
      '事実と推測を区別して書く',
      '情報が古い・不確かな場合はその旨を明記する',
    ],
    provider: 'claude-code',
    tools: [...WRITE, ...WEB],
  },
  {
    id: 'market_analyst',
    name: '市場調査',
    mission: '市場規模・競合・顧客ニーズ・価格帯を調査し、事業機会とリスクを評価する。',
    criteria: [
      '市場規模の推定には算出根拠(式と前提)を示す',
      '主要な競合を比較表にまとめる',
      '想定顧客と課題を具体的に定義する',
      '機会だけでなくリスクと不確実性を挙げる',
    ],
    provider: 'claude-code',
    tools: [...WRITE, ...WEB],
  },
  {
    id: 'data_analyst',
    name: 'データ分析',
    mission: 'データを集計・分析し、意思決定に使える示唆を出す。',
    criteria: [
      '分析は再実行できるスクリプトとして残す',
      'データの出所・前処理・前提を明記する',
      '数値は単位と期間を明記する',
      '相関と因果を混同しない',
    ],
    provider: 'claude-code',
    tools: [...WRITE, 'Bash'],
  },
  {
    id: 'product_planner',
    name: '商品企画',
    mission: '調査と分析をもとに商品・サービスのコンセプト、提供価値、価格、ロードマップを企画する。',
    criteria: [
      '誰のどんな課題を解決するかが一文で言える',
      '調査結果のどの根拠に基づく判断かを示す',
      '差別化要因と価格の根拠がある',
      '検証すべき仮説と検証方法を挙げる',
    ],
    provider: 'claude-code',
    tools: WRITE,
  },
  {
    id: 'copywriter',
    name: '文章制作',
    mission: '商品説明・記事・LPコピーなどの文章を、対象読者に合わせて制作する。',
    criteria: [
      '対象読者と目的に合った語調・長さである',
      '事実に基づき、誇大・誤認を招く表現がない',
      '誤字脱字がない',
      '行動を促す明確なメッセージがある',
    ],
    provider: 'claude-code',
    tools: WRITE,
  },
  {
    id: 'designer',
    name: '画像・ビジュアル制作',
    mission: 'ロゴ・バナー・図版などのビジュアルを制作する(SVG、または画像生成用の詳細な仕様)。',
    criteria: [
      'ブランドとターゲットに合ったトーンである',
      '文字の可読性とコントラストが確保されている',
      '用途ごとのサイズ・形式の要件を満たす',
      '第三者の権利を侵害する素材を使っていない',
    ],
    provider: 'claude-code',
    tools: WRITE,
  },
  {
    id: 'web_developer',
    name: 'Web制作',
    mission: 'Webサイト・LPを実装し、動作確認する。公開(デプロイ)は承認後に行う。',
    criteria: [
      'スマートフォン・タブレットで崩れない',
      'アクセシビリティの基本(代替テキスト、見出し構造、コントラスト)を満たす',
      'リンク切れ・コンソールエラーがない',
      '秘密情報をコードに含めない',
    ],
    provider: 'claude-code',
    tools: [...WRITE, 'Bash'],
  },
  {
    id: 'qa_reviewer',
    name: '品質検証',
    mission: '成果物が要件と判断基準を満たしているかを検証し、問題があれば原因と修正方法を示す。',
    criteria: [
      '要件・判断基準の各項目について合否を判断する',
      '問題には再現手順または該当箇所を示す',
      '問題の根本原因を分析する',
      '具体的で実行可能な修正案を出す',
    ],
    provider: 'claude-code',
    tools: [...READ_ONLY, 'Bash', 'WebFetch'],
  },
];
