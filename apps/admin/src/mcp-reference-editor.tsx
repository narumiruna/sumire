import type { RuntimeConfigResponse } from "@narumitw/sumire-contracts"
import { Button, Flex, Text, TextField } from "@radix-ui/themes"
import { useEffect, useId, useState } from "react"
import { request } from "./api.js"
import { parseRuntimeConfig } from "./runtime-config-state.js"
import { SectionSelect } from "./sections.js"
import { Prose } from "./surfaces.js"

export function storedReference(name: string, prefix = "") {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) throw new Error("Enter a valid stored name.")
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
      <Prose size="2">
        Use explicit {`\${NAME}`} references in headers or environment fields. Values are resolved
        from Secrets & variables for each connection, not from the host environment. References
        grant no tool permissions. Missing names can be saved but are unavailable until configured.
        Do not put references in commands, arguments, URLs, or working directories.
      </Prose>
      <Flex gap="3" wrap="wrap">
        <label htmlFor={`${id}-scope`}>
          Binding scope
          <SectionSelect.Root
            value={scope}
            onValueChange={(value) => setScope(value as "env" | "headers")}
          >
            <SectionSelect.Trigger id={`${id}-scope`} aria-label="Binding scope" />
            <SectionSelect.Content>
              <SectionSelect.Item value="headers">headers</SectionSelect.Item>
              <SectionSelect.Item value="env">env</SectionSelect.Item>
            </SectionSelect.Content>
          </SectionSelect.Root>
        </label>
        <label htmlFor={`${id}-field`}>
          Binding field name
          <TextField.Root
            id={`${id}-field`}
            value={field}
            onChange={(event) => setField(event.target.value)}
          />
        </label>
        <label htmlFor={`${id}-name`}>
          Stored name
          <TextField.Root
            id={`${id}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label htmlFor={`${id}-prefix`}>
          Literal prefix (not a secret)
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
        Load stored names
      </Button>
      {names.length > 0 && (
        <label htmlFor={`${id}-stored`}>
          Choose stored reference
          <SectionSelect.Root value={names.includes(name) ? name : ""} onValueChange={setName}>
            <SectionSelect.Trigger
              id={`${id}-stored`}
              aria-label="Choose stored reference"
              placeholder="Choose a name"
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
          Clear reference input
        </Button>
      )}
      <Text size="2">Only names are listed; stored values are never inserted into this draft.</Text>
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
        Stage stored reference
      </Button>
    </div>
  )
}
