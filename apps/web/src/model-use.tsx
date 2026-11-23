import { effectivePolicy, inherited } from "@narumitw/sumire-policy"
import { Button } from "@react-spectrum/s2/Button"
import { type ComponentRef, useContext, useEffect, useId, useRef, useState } from "react"
import { flushSync } from "react-dom"
import type { Policy, Selection } from "./api.js"
import { selectDefaultModel } from "./default-model.js"
import { t } from "./i18n.js"
import { focusProviderControl, ProviderDialog } from "./provider-spectrum.js"
import { PickerOption, SectionPicker } from "./section-picker.js"
import { SectionActive } from "./sections.js"
import { Prose } from "./surfaces.js"

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
  const dialogId = useId()
  const trigger = useRef<ComponentRef<typeof Button>>(null)
  const returnFocus = useRef(false)
  useEffect(() => {
    if (!active) {
      returnFocus.current = false
      setOpen(false)
    } else if (!open && returnFocus.current) {
      returnFocus.current = false
      focusProviderControl(trigger.current?.UNSAFE_getDOMNode())
    }
  }, [active, open])
  const cancel = () => {
    returnFocus.current = true
    setOpen(false)
  }
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
    <>
      <Button
        ref={trigger}
        variant="secondary"
        size="XL"
        isDisabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open && active}
        aria-controls={open && active ? dialogId : undefined}
        onPress={() => {
          setTarget(chat ? "chat" : "defaults")
          setOpen(true)
        }}
      >
        {t("model.chooseUse")}
      </Button>
      {open && active && (
        <ProviderDialog
          id={dialogId}
          title={t("model.chooseUseTitle")}
          description={t("model.useDescription", { model })}
          dismissOutside
          onClose={cancel}
        >
          <label className="form-field" htmlFor="model-use-target">
            {t("model.use")}
            <SectionPicker
              value={target}
              onValueChange={(value) => setTarget(value as ModelUseTarget)}
              id="model-use-target"
              aria-label={t("model.use")}
            >
              <PickerOption id="defaults">{t("model.sharedDefault")}</PickerOption>
              {chat && <PickerOption id="chat">{t("model.chatOverride", { chat })}</PickerOption>}
              {chat && (
                <PickerOption id="inherit">{t("model.chatInherits", { chat })}</PickerOption>
              )}
            </SectionPicker>
          </label>
          <Prose size="2" role="status">
            {pending
              ? t("model.usePending")
              : matches
                ? t("model.useSaved")
                : t("model.useIncomplete")}
          </Prose>
          {target === "inherit" && effectivePolicy(policy, 0).model !== model && (
            <Prose color="orange">{t("model.inheritRequiresDefault")}</Prose>
          )}
          {target === "inherit" && <Prose size="2">{t("model.inheritUseHelp")}</Prose>}
          <div className="provider-controls provider-controls--end">
            <Button variant="secondary" size="XL" onPress={cancel}>
              {t("selection.cancel")}
            </Button>
            <Button
              variant="accent"
              size="XL"
              isDisabled={disabled || unchanged}
              onPress={() => {
                // Remove the modal's inert background before Review moves focus there.
                flushSync(() => setOpen(false))
                onReview(next)
              }}
            >
              {t("model.reviewUse")}
            </Button>
          </div>
        </ProviderDialog>
      )}
    </>
  )
}
