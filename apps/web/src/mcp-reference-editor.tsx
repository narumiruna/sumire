import type { RuntimeConfigResponse } from "@narumitw/sumire-contracts"
import { Button, Flex, Text, TextField } from "@radix-ui/themes"
import { useEffect, useId, useState } from "react"
import { request } from "./api.js"
import { t } from "./i18n.js"
import { parseRuntimeConfig } from "./runtime-config-state.js"
import { SectionSelect } from "./sections.js"
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
      <Flex gap="3" wrap="wrap">
        <label htmlFor={`${id}-scope`}>
          {t("mcp.bindingScope")}
          <SectionSelect.Root
            value={scope}
            onValueChange={(value) => setScope(value as "env" | "headers")}
          >
            <SectionSelect.Trigger id={`${id}-scope`} aria-label={t("mcp.bindingScope")} />
            <SectionSelect.Content>
              <SectionSelect.Item value="headers">{t("mcp.headers")}</SectionSelect.Item>
              <SectionSelect.Item value="env">{t("mcp.environment")}</SectionSelect.Item>
            </SectionSelect.Content>
          </SectionSelect.Root>
        </label>
        <label htmlFor={`${id}-field`}>
          {t("mcp.bindingField")}
          <TextField.Root
            id={`${id}-field`}
            value={field}
            onChange={(event) => setField(event.target.value)}
          />
        </label>
        <label htmlFor={`${id}-name`}>
          {t("mcp.storedName")}
          <TextField.Root
            id={`${id}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label htmlFor={`${id}-prefix`}>
          {t("mcp.literalPrefix")}
          <TextField.Root
            id={`${id}-prefix`}
            value={prefix}
            placeholder="Bearer "
            onChange={(event) => setPrefix(event.target.value)}
          />
        </label>
      </Flex>
      <Button
        variant="soft"
        onClick={() =>
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
          <SectionSelect.Root value={names.includes(name) ? name : ""} onValueChange={setName}>
            <SectionSelect.Trigger
              id={`${id}-stored`}
              aria-label={t("mcp.chooseReference")}
              placeholder={t("mcp.chooseName")}
            />
            <SectionSelect.Content>
              {names.map((item) => (
                <SectionSelect.Item key={item} value={item}>
                  {item}
                </SectionSelect.Item>
              ))}
            </SectionSelect.Content>
          </SectionSelect.Root>
        </label>
      )}
      {pending && (
        <Button
          variant="soft"
          onClick={() => {
            setField("")
            setName("")
            setPrefix("")
          }}
        >
          {t("mcp.clearReference")}
        </Button>
      )}
      <Text size="2">{t("mcp.referencePrivacy")}</Text>
      <Button
        variant="soft"
        disabled={!field || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name)}
        onClick={() => {
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
