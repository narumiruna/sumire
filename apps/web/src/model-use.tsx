import { effectivePolicy, inherited } from "@narumitw/sumire-policy"
import { Button, Dialog, Flex, Text } from "@radix-ui/themes"
import { useContext, useEffect, useState } from "react"
import type { Policy, Selection } from "./api.js"
import { selectDefaultModel } from "./default-model.js"
import { t } from "./i18n.js"
import { SectionActive, SectionSelect as Select } from "./sections.js"

export type ModelUseTarget = "defaults" | "chat" | "inherit"

/** Stage only the selected model scope; persistence remains in the policy review. */
export function stageModelUse(
  policy: Policy,
  ref: string,
  thinking: Selection["thinking"],
  target: ModelUseTarget,
  chat: string,
): Policy {
  if (!policy.models.includes(ref)) return policy
  if (target === "defaults")
    return { ...policy, defaults: selectDefaultModel(policy.defaults, ref, thinking) }
  if (!/^-?[1-9]\d*$/.test(chat) || !Number.isSafeInteger(Number(chat))) return policy
  const current = policy.chats[chat] ?? { ...inherited, enabled: true }
  if (target === "inherit" && effectivePolicy(policy, 0).model !== ref) return policy
  const selection =
    target === "inherit"
      ? { model: null, thinking: null, models: null }
      : {
          model: ref,
          thinking,
          models: [...new Set([...(current.models ?? policy.defaults.models ?? []), ref])],
        }
  return { ...policy, chats: { ...policy.chats, [chat]: { ...current, ...selection } } }
}

export function ModelUse({
  policy,
  saved,
  model,
  thinking,
  chat,
  disabled,
  onReview,
}: {
  policy: Policy
  saved: Policy
  model: string
  thinking: Selection["thinking"]
  chat: string
  disabled: boolean
  onReview(policy: Policy): void
}) {
  const active = useContext(SectionActive)
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<ModelUseTarget>("defaults")
  useEffect(() => {
    if (!active) setOpen(false)
  }, [active])
  const next = stageModelUse(policy, model, thinking, target, chat)
  const unchanged = JSON.stringify(next) === JSON.stringify(policy)
  const savedSelection = target === "defaults" ? saved.defaults : (saved.chats[chat] ?? inherited)
  const draftSelection = target === "defaults" ? policy.defaults : (policy.chats[chat] ?? inherited)
  const pending = JSON.stringify(savedSelection) !== JSON.stringify(draftSelection)
  const matches =
    target === "inherit"
      ? Boolean(
          effectivePolicy(saved, Number(chat)).model === model &&
            savedSelection.model === null &&
            savedSelection.models === null &&
            savedSelection.thinking === null,
        )
      : savedSelection?.model === model && savedSelection?.thinking === thinking
  return (
    <Dialog.Root open={open && active} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button
          variant="soft"
          disabled={disabled}
          onClick={() => setTarget(chat ? "chat" : "defaults")}
        >
          {t("model.chooseUse")}
        </Button>
      </Dialog.Trigger>
      <Dialog.Content
        onCloseAutoFocus={(event) => {
          if (!active) event.preventDefault()
        }}
      >
        <Dialog.Title>{t("model.chooseUseTitle")}</Dialog.Title>
        <Dialog.Description>{t("model.useDescription", { model })}</Dialog.Description>
        <label className="form-field" htmlFor="model-use-target">
          {t("model.use")}
          <Select.Root value={target} onValueChange={(value) => setTarget(value as ModelUseTarget)}>
            <Select.Trigger id="model-use-target" aria-label={t("model.use")} />
            <Select.Content>
              <Select.Item value="defaults">{t("model.sharedDefault")}</Select.Item>
              {chat && <Select.Item value="chat">{t("model.chatOverride", { chat })}</Select.Item>}
              {chat && (
                <Select.Item value="inherit">{t("model.chatInherits", { chat })}</Select.Item>
              )}
            </Select.Content>
          </Select.Root>
        </label>
        <Text as="p" size="2" role="status">
          {pending
            ? t("model.usePending")
            : matches
              ? t("model.useSaved")
              : t("model.useIncomplete")}
        </Text>
        {target === "inherit" && effectivePolicy(policy, 0).model !== model && (
          <Text as="p" color="orange">
            {t("model.inheritRequiresDefault")}
          </Text>
        )}
        {target === "inherit" && (
          <Text as="p" size="2">
            {t("model.inheritUseHelp")}
          </Text>
        )}
        <Flex gap="3" mt="4" justify="end" wrap="wrap">
          <Dialog.Close>
            <Button variant="soft">{t("selection.cancel")}</Button>
          </Dialog.Close>
          <Button
            disabled={disabled || unchanged}
            onClick={() => {
              setOpen(false)
              onReview(next)
            }}
          >
            {t("model.reviewUse")}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  )
}
