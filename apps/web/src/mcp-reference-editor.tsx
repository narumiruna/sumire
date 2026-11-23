import type { RuntimeConfigResponse } from "@narumitw/sumire-contracts"
import { Button } from "@react-spectrum/s2/Button"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { TextField } from "@react-spectrum/s2/TextField"
import { useEffect, useId, useState } from "react"
import { request } from "./api.js"
import { t } from "./i18n.js"
import { parseRuntimeConfig } from "./runtime-config-state.js"
import { PickerOption, SectionPicker } from "./section-picker.js"
import { Prose } from "./surfaces.js"

export function storedReference(name: string, prefix = "") {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) throw new Error(t("mcp.referenceInvalid"))
  return `${prefix}\${${name}}`
}

/** Store reference text only. Saved inline fields remain masked in inventory. */
export function McpReferenceEditor({
  onAdd,
  onPending,
  run,
}: {
  onPending(value: boolean): void
  onAdd(value: { scope: "env" | "headers"; name: string; value: string }): void
  run(action: () => Promise<void>): Promise<void>
}) {
  const id = useId()
  const [scope, setScope] = useState<"env" | "headers">("headers")
  const [field, setField] = useState("")
  const [name, setName] = useState("")
  const [prefix, setPrefix] = useState("")
  const [names, setNames] = useState<string[]>([])
  const pending = Boolean(field || name || prefix)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only input changes update parent pending state.
  useEffect(() => {
    onPending(pending)
  }, [pending])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Clear pending state when the editor is reset.
  useEffect(() => () => onPending(false), [])
  return (
    <div className="settings-stack" id="mcp-reference-editor" tabIndex={-1}>
      <Prose size="2">{t("mcp.referenceHelp", { reference: `\${NAME}` })}</Prose>
      <div className={style({ display: "flex", flexWrap: "wrap", gap: 12 })}>
        <label htmlFor={`${id}-scope`}>
          {t("mcp.bindingScope")}
          <SectionPicker
            value={scope}
            onValueChange={(value) => setScope(value as "env" | "headers")}
            id={`${id}-scope`}
            aria-label={t("mcp.bindingScope")}
          >
            <PickerOption id="headers">{t("mcp.headers")}</PickerOption>
            <PickerOption id="env">{t("mcp.environment")}</PickerOption>
          </SectionPicker>
        </label>
        <TextField
          id={`${id}-field`}
          label={t("mcp.bindingField")}
          size="XL"
          value={field}
          onChange={setField}
        />
        <TextField
          id={`${id}-name`}
          label={t("mcp.storedName")}
          size="XL"
          value={name}
          onChange={setName}
        />
        <TextField
          id={`${id}-prefix`}
          label={t("mcp.literalPrefix")}
          size="XL"
          value={prefix}
          placeholder="Bearer "
          onChange={setPrefix}
        />
      </div>
      <Button
        variant="secondary"
        onPress={() =>
          void run(async () => {
            const metadata = parseRuntimeConfig(
              await request<RuntimeConfigResponse>("runtime-config"),
            )
            setNames(metadata.entries.map((entry) => entry.name))
          })
        }
      >
        {t("mcp.loadNames")}
      </Button>
      {names.length > 0 && (
        <label htmlFor={`${id}-stored`}>
          {t("mcp.chooseReference")}
          <SectionPicker
            value={names.includes(name) ? name : ""}
            onValueChange={setName}
            id={`${id}-stored`}
            aria-label={t("mcp.chooseReference")}
            placeholder={t("mcp.chooseName")}
          >
            {names.map((item) => (
              <PickerOption key={item} id={item}>
                {item}
              </PickerOption>
            ))}
          </SectionPicker>
        </label>
      )}
      {pending && (
        <Button
          variant="secondary"
          onPress={() => {
            setField("")
            setName("")
            setPrefix("")
          }}
        >
          {t("mcp.clearReference")}
        </Button>
      )}
      <Prose>{t("mcp.referencePrivacy")}</Prose>
      <Button
        variant="primary"
        isDisabled={!field || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name)}
        onPress={() => {
          onAdd({ scope, name: field, value: storedReference(name, prefix) })
          setField("")
          setName("")
          setPrefix("")
        }}
      >
        {t("mcp.stageReference")}
      </Button>
    </div>
  )
}
