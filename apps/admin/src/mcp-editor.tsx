import { InfoCircledIcon, PlusIcon, TrashIcon } from "@radix-ui/react-icons"
import {
  Box,
  Button,
  Callout,
  Checkbox,
  Flex,
  Grid,
  Heading,
  Text,
  TextField,
} from "@radix-ui/themes"
import { useId } from "react"
import type { Inventory } from "./api.js"
import { SectionSelect } from "./sections.js"
import { Prose } from "./surfaces.js"

const fields = [
  "type",
  "command",
  "args",
  "cwd",
  "env",
  "url",
  "headers",
  "description",
  "enabled",
  "timeout",
  "exposure",
  "toolExposure",
]
export type McpPatch = Record<string, unknown>
export function parseMcpPatch(text: string): McpPatch {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Enter a configuration object.")
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error("Unknown fields: correct them in advanced JSON. The draft is unchanged.")
  const patch = value as McpPatch
  for (const key of ["command", "url", "cwd", "description"] as const)
    if (key in patch && typeof patch[key] !== "string")
      throw new Error(`Correct ${key} in advanced JSON. The draft is unchanged.`)
  if ("enabled" in patch && typeof patch.enabled !== "boolean")
    throw new Error("Correct enabled in advanced JSON. The draft is unchanged.")
  if ("timeout" in patch && (typeof patch.timeout !== "number" || !Number.isFinite(patch.timeout)))
    throw new Error("Timeout must be a positive number; correct advanced JSON.")
  for (const [key, options] of [
    ["type", ["stdio", "http", "streamable-http"]],
    ["exposure", ["codemode", "direct", "hidden"]],
  ] as const)
    if (key in patch && !options.some((option) => option === patch[key]))
      throw new Error(`Correct ${key} in advanced JSON. The draft is unchanged.`)
  return patch
}

/** Masked replacements preserve the saved map only when the patch omits that map. */
export function mcpSavePatch(
  text: string,
  previous: Inventory["mcp"][number] | undefined,
  secrets: { env: Record<string, string>; headers: Record<string, string> },
) {
  const config = parseMcpPatch(text)
  if (typeof config.timeout === "number" && config.timeout <= 0)
    throw new Error("Timeout must be positive.")
  for (const scope of ["env", "headers"] as const) {
    const map = config[scope]
    if (
      map !== undefined &&
      (!map ||
        typeof map !== "object" ||
        Array.isArray(map) ||
        Object.values(map).some((value) => value !== null))
    )
      throw new Error("Use the masked field for secret replacements")
    if (Object.keys(secrets[scope]).length)
      config[scope] = { ...(map ?? previous?.[scope] ?? {}), ...secrets[scope] }
  }
  return config
}

/** Field operations only. Never include values, including legacy command or URL secrets. */
export function mcpChangePreview(patch: McpPatch, previous?: Inventory["mcp"][number]) {
  const operations: { field: string; name?: string; action: string }[] = []
  const add = (field: string, action: string, name?: string) =>
    operations.push({ field, action, name })
  const known = new Set(previous?.fields ?? [])
  for (const key of known)
    if (!(key in patch) && key !== "env" && key !== "headers") add(key, "Preserved")
  for (const [key, value] of Object.entries(patch)) {
    if (key === "env" || key === "headers") {
      const old = previous?.[key] ?? {}
      const map = value as Record<string, unknown>
      for (const [name, secret] of Object.entries(map))
        add(key, secret === null ? "Preserved" : name in old ? "Replaced" : "Added", name)
      for (const name of Object.keys(old)) if (!(name in map)) add(key, "Removed", name)
      if (!Object.keys(map).length) add(key, "Cleared")
    } else add(key, known.has(key) ? "Set / replaced" : "Set")
  }
  for (const scope of ["env", "headers"] as const)
    if (!(scope in patch))
      for (const name of Object.keys(previous?.[scope] ?? {})) add(scope, "Preserved", name)
  if (
    (patch.command !== undefined || patch.url !== undefined) &&
    patch.type === undefined &&
    known.has("type")
  ) {
    const index = operations.findIndex(
      (operation) => operation.field === "type" && operation.action === "Preserved",
    )
    if (index >= 0) operations.splice(index, 1)
    add("type", "Removed / inferred")
  }
  const http = patch.command === undefined && (patch.url !== undefined || known.has("url"))
  const removed = http
    ? ["command", "cwd", "args", "env"]
    : patch.command !== undefined
      ? ["url", "headers"]
      : ["headers"]
  // Transport cleanup wins over the patch and preserved fields.
  return [
    ...operations
      .filter((operation) => !removed.includes(operation.field))
      .map(
        ({ field, name, action }) =>
          `${action}: ${field}${action === "Cleared" ? " map" : name !== undefined ? `.${name}` : ""}`,
      ),
    ...removed
      .filter(
        (key) =>
          known.has(key) ||
          key in patch ||
          (key === "env" && Object.keys(previous?.env ?? {}).length > 0) ||
          (key === "headers" && Object.keys(previous?.headers ?? {}).length > 0),
      )
      .map((key) => `Removed by transport selection: ${key}`),
  ]
}

export function McpGuidedEditor({
  text,
  onChange,
}: {
  text: string
  onChange(text: string): void
}) {
  const prefix = useId()
  let patch: McpPatch
  try {
    patch = parseMcpPatch(text)
    if (
      patch.args !== undefined &&
      (!Array.isArray(patch.args) || patch.args.some((arg) => typeof arg !== "string"))
    )
      throw new Error("Edit invalid arguments in advanced JSON. The draft is unchanged.")
  } catch (error) {
    return (
      <Callout.Root color="red" role="alert" size="1">
        <Callout.Icon>
          <InfoCircledIcon />
        </Callout.Icon>
        <Callout.Text>
          {error instanceof Error ? error.message : "Correct advanced JSON to use guided fields."}
        </Callout.Text>
      </Callout.Root>
    )
  }
  const set = (key: string, value: unknown) =>
    onChange(JSON.stringify({ ...patch, [key]: value }, null, 2))
  const omit = (key: string) => {
    const next = { ...patch }
    delete next[key]
    onChange(JSON.stringify(next, null, 2))
  }
  return (
    <fieldset
      className="mcp-guided-editor"
      id="mcp-guided"
      tabIndex={-1}
      aria-labelledby={`${prefix}-heading`}
    >
      <Heading as="h3" size="3" id={`${prefix}-heading`}>
        Guided connection fields
      </Heading>
      <Prose size="2" id={`${prefix}-replacement-help`}>
        Only selected fields change. Omitted fields stay saved. Existing values are not returned;
        enter replacements only.
      </Prose>
      <Text
        as="label"
        size="2"
        weight="medium"
        className="mcp-guided-toolbar"
        htmlFor={`${prefix}-transport`}
      >
        Transport update
        <SectionSelect.Root
          value={
            patch.url !== undefined ? "http" : patch.command !== undefined ? "stdio" : "preserve"
          }
          onValueChange={(value) => {
            const next = { ...patch }
            delete next.command
            delete next.url
            delete next.type
            if (value === "http") {
              next.url = ""
              next.type = "http"
            }
            if (value === "stdio") {
              next.command = ""
              next.type = "stdio"
            }
            onChange(JSON.stringify(next, null, 2))
          }}
        >
          <SectionSelect.Trigger id={`${prefix}-transport`} aria-label="Transport update" />
          <SectionSelect.Content>
            <SectionSelect.Item value="preserve">Keep saved transport</SectionSelect.Item>
            <SectionSelect.Item value="stdio">Replace with stdio command</SectionSelect.Item>
            <SectionSelect.Item value="http">Replace with HTTP endpoint</SectionSelect.Item>
          </SectionSelect.Content>
        </SectionSelect.Root>
      </Text>
      <Grid columns={{ initial: "1", sm: "2" }} gap="4" className="mcp-field-grid" mt="4">
        {(
          [
            "command",
            "url",
            "cwd",
            "description",
            "timeout",
            "enabled",
            "exposure",
            "type",
          ] as const
        ).map((key) => (
          <Flex key={key} direction="column" gap="2" className="mcp-field">
            <Text
              as="label"
              size="2"
              className="check mcp-field-toggle"
              htmlFor={`${prefix}-${key}-edit`}
            >
              <Checkbox
                id={`${prefix}-${key}-edit`}
                aria-label={`Edit MCP ${key}`}
                aria-describedby={`${prefix}-replacement-help`}
                checked={key in patch}
                onCheckedChange={(checked) =>
                  checked === true
                    ? set(
                        key,
                        key === "enabled"
                          ? true
                          : key === "timeout"
                            ? 30
                            : key === "exposure"
                              ? "codemode"
                              : key === "type"
                                ? "stdio"
                                : "",
                      )
                    : omit(key)
                }
              />
              Replace {key}
            </Text>
            {key in patch &&
              (key === "enabled" ? (
                <label className="check mcp-field-value" htmlFor={`${prefix}-enabled-value`}>
                  <Checkbox
                    id={`${prefix}-enabled-value`}
                    aria-label="MCP enabled value"
                    checked={patch.enabled === true}
                    onCheckedChange={(v) => set(key, v === true)}
                  />
                  Enabled after save
                </label>
              ) : key === "exposure" || key === "type" ? (
                <label className="mcp-field-value" htmlFor={`${prefix}-${key}-value`}>
                  Replacement {key}
                  <SectionSelect.Root
                    value={String(patch[key])}
                    onValueChange={(value) => set(key, value)}
                  >
                    <SectionSelect.Trigger
                      id={`${prefix}-${key}-value`}
                      aria-label={`MCP ${key} replacement`}
                    />
                    <SectionSelect.Content>
                      {(key === "exposure"
                        ? ["codemode", "direct", "hidden"]
                        : ["stdio", "http", "streamable-http"]
                      ).map((value) => (
                        <SectionSelect.Item key={value} value={value}>
                          {value}
                        </SectionSelect.Item>
                      ))}
                    </SectionSelect.Content>
                  </SectionSelect.Root>
                </label>
              ) : (
                <label className="mcp-field-value" htmlFor={`${prefix}-${key}-value`}>
                  Replacement {key}
                  <TextField.Root
                    id={`${prefix}-${key}-value`}
                    aria-label={`MCP ${key} replacement`}
                    type={key === "timeout" ? "number" : "text"}
                    value={String(patch[key] ?? "")}
                    onChange={(e) =>
                      set(key, key === "timeout" ? Number(e.target.value) : e.target.value)
                    }
                  />
                </label>
              ))}
          </Flex>
        ))}
      </Grid>
      <Box className="mcp-arguments" mt="5">
        <Heading size="2" mb="3">
          Arguments
        </Heading>
        {(Array.isArray(patch.args) ? (patch.args as string[]) : []).map((arg, index) => (
          // Arguments are controlled positional fields with no row state; additions append only.
          <Flex
            // biome-ignore lint/suspicious/noArrayIndexKey: Argument position is the field identity.
            key={`${prefix}-${index}`}
            className="mcp-argument-row"
            gap="3"
            align="end"
            wrap="wrap"
            mb="3"
          >
            <Text as="label" size="2" htmlFor={`${prefix}-arg-${index}`}>
              Argument {index + 1}
              <TextField.Root
                id={`${prefix}-arg-${index}`}
                aria-label={`MCP argument ${index + 1}`}
                value={arg}
                onChange={(e) =>
                  set(
                    "args",
                    (patch.args as string[]).map((v, i) => (i === index ? e.target.value : v)),
                  )
                }
              />
            </Text>
            <Button
              variant="soft"
              onClick={() =>
                set(
                  "args",
                  (patch.args as string[]).filter((_, i) => i !== index),
                )
              }
            >
              <TrashIcon aria-hidden="true" />
              Remove argument {index + 1}
            </Button>
          </Flex>
        ))}
        <Flex gap="2" wrap="wrap">
          <Button
            variant="soft"
            onClick={() => set("args", [...(Array.isArray(patch.args) ? patch.args : []), ""])}
          >
            <PlusIcon aria-hidden="true" />
            Add argument
          </Button>
          {"args" in patch && (
            <Button variant="soft" onClick={() => omit("args")}>
              Keep saved arguments
            </Button>
          )}
        </Flex>
      </Box>
      <Prose size="2" color="gray">
        Use masked fields below for secret replacements. Use advanced JSON for secret-map removal,
        preservation markers, and per-tool exposure; guided edits retain those fields.
      </Prose>
    </fieldset>
  )
}
