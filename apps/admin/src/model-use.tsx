import { effectivePolicy, inherited } from "@narumitw/sumire-policy"
import { Button, Dialog, Flex, Text } from "@radix-ui/themes"
import { useContext, useEffect, useState } from "react"
import type { Policy, Selection } from "./api.js"
import { selectDefaultModel } from "./default-model.js"
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
          Choose model use
        </Button>
      </Dialog.Trigger>
      <Dialog.Content
        onCloseAutoFocus={(event) => {
          if (!active) event.preventDefault()
        }}
      >
        <Dialog.Title>Choose where to use this model</Dialog.Title>
        <Dialog.Description>
          Use {model}. Earlier credential and availability saves remain saved if you cancel. This
          step stages policy changes only. The review includes other pending policy edits.
        </Dialog.Description>
        <label className="form-field" htmlFor="model-use-target">
          Model use
          <Select.Root value={target} onValueChange={(value) => setTarget(value as ModelUseTarget)}>
            <Select.Trigger id="model-use-target" aria-label="Model use" />
            <Select.Content>
              <Select.Item value="defaults">Shared default</Select.Item>
              {chat && <Select.Item value="chat">Chat {chat} override</Select.Item>}
              {chat && <Select.Item value="inherit">Chat {chat} inherits shared model</Select.Item>}
            </Select.Content>
          </Select.Root>
        </label>
        <Text as="p" size="2" role="status">
          {pending
            ? "Policy changes pending"
            : matches
              ? "Model use saved"
              : "Model use incomplete"}
        </Text>
        {target === "inherit" && effectivePolicy(policy, 0).model !== model && (
          <Text as="p" color="orange">
            The shared default does not use this model. Choose Shared default first, or use a chat
            override.
          </Text>
        )}
        {target === "inherit" && (
          <Text as="p" size="2">
            Clear this chat’s model, thinking, and allowed-model overrides. Other chat settings stay
            unchanged.
          </Text>
        )}
        <Flex gap="3" mt="4" justify="end" wrap="wrap">
          <Dialog.Close>
            <Button variant="soft">Cancel</Button>
          </Dialog.Close>
          <Button
            disabled={disabled || unchanged}
            onClick={() => {
              setOpen(false)
              onReview(next)
            }}
          >
            Review model use
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  )
}
