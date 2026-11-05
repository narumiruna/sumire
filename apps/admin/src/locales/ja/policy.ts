import type { policyMessages as sourceMessages } from "../en/policy.js"
import type { Catalog } from "../types.js"

export const policyMessages = {
  "policy.invalidTelegramId": "有効なゼロ以外の Telegram ID を入力してください",
  "policy.field.tools": "許可されたツール",
  "policy.field.skills": "有効なスキル",
  "policy.field.servers": "許可された MCP サーバー",
  "policy.field.models": "許可されたモデル",
  "policy.field.model": "モデル",
  "policy.field.thinking": "思考レベル",
  "policy.field.enabled": "有効化スイッチ",
  "policy.field.enabledReset": "有効化スイッチ（リセット）",
  "policy.field.baseUrl": "エンドポイント URL",
  "policy.field.api": "API プロトコル",
  "policy.field.modelId": "モデル ID",
  "policy.field.name": "表示名",
  "policy.field.reasoning": "推論のサポート",
  "policy.field.image": "画像のサポート",
  "policy.field.contextWindow": "コンテキストウィンドウ",
  "policy.field.maxTokens": "最大出力トークン数",
  "policy.source.inherit": "共通の既定値を継承",
  "policy.source.noDefault": "共通の既定値なし",
  "policy.source.emptyOverride": "明示的な空の上書き",
  "policy.source.emptySelection": "明示的な空の選択",
  "policy.source.override": "明示的な上書き",
  "policy.source.selection": "明示的な選択",
  "policy.selection": "{field}（{source}）",
  "policy.listSeparator": "、",
  "policy.provider.added": "プロバイダー設定を追加",
  "policy.provider.removed": "プロバイダー設定を削除",
  "policy.provider.modelDefinitions": "モデル定義",
  "policy.provider.modelDetails": "モデル定義（{detail}）",
  "policy.provider.entryOrder": "項目の順序",
  "policy.provider.order": "プロバイダーの順序",
  "policy.scope.privateUsers": "ダイレクトメッセージのアクセス権",
  "policy.scope.groups": "グループ／チャンネルのアクセス権",
  "policy.access.approve": "{scope}：{id} を承認",
  "policy.access.revoke": "{scope}：{id} の承認を取り消し",
  "policy.chat.changed":
    "チャット {id}：{fields} — このチャットのみ。共通の既定値とアクセス承認は変更されません。",
  "policy.chat.added":
    "チャット {id}：設定を追加；{fields} — このチャットのみ。共通の既定値とアクセス承認は変更されません。",
  "policy.chat.removed":
    "チャット {id}：設定を削除；{fields} — このチャットのみ。共通の既定値とアクセス承認は変更されません。",
  "policy.github.add":
    "GitHub メンション：ユーザー名 {username} を追加 — GitHub での自動返信。Telegram チャットやツールの権限には依存しません。",
  "policy.github.remove":
    "GitHub メンション：ユーザー名 {username} を削除 — GitHub での自動返信。Telegram チャットやツールの権限には依存しません。",
  "policy.defaults.changed":
    "共通の既定値：{fields} — 変更した各フィールドを継承するチャットに影響します。明示的な上書きは変更されず、アクセス権は付与されません。",
  "policy.global.tools": "グローバルなツールの利用可否",
  "policy.global.skills": "グローバルなスキルの利用可否",
  "policy.global.servers": "グローバルな MCP の利用可否",
  "policy.global.models": "グローバルなモデルの利用可否",
  "policy.global.changed":
    "{scope}（{key}）：共通の既定値と、明示的な上書きを含むすべてのチャットの選択を制限します。アクセス権は付与されません。",
  "policy.provider.changed":
    "プロバイダー設定：{fields} — グローバルなプロバイダー設定。明示的な上書きを含め、これらのプロバイダーを使用するチャットに影響する可能性があります。",
  "policy.recovery.groups": "グループとチャンネルのアクセス権",
  "policy.recovery.providers": "プロバイダーの設定と順序",
  "policy.recovery.github": "GitHub メンションの投稿者",
  "policy.recovery.default": "共通の既定値：{field}",
  "policy.recovery.chat": "チャット {id} の設定",
} as const satisfies Catalog<typeof sourceMessages>
