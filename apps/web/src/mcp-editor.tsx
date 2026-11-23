import { Button } from "@react-spectrum/s2/Button"
import { Content, InlineAlert } from "@react-spectrum/s2/InlineAlert"
import Add from "@react-spectrum/s2/icons/Add"
import Delete from "@react-spectrum/s2/icons/Delete"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { TextField } from "@react-spectrum/s2/TextField"
import { useId } from "react"
import type { Inventory } from "./api.js"
import { Check } from "./check.js"
import { type MessageKey, t } from "./i18n.js"
import { PickerOption, SectionPicker } from "./section-picker.js"
import { Prose } from "./surfaces.js"
import "./spectrum-mcp.css"

const fullWidth = style({ width: "full" })
const argumentActions = style({ display: "flex", flexWrap: "wrap", gap: 8 })

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
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(t("mcp.jsonInvalid"))
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(t("mcp.objectRequired"))
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error(t("mcp.unknownFields"))
  const patch = value as McpPatch
  for (const key of ["command", "url", "cwd", "description"] as const)
    if (key in patch && typeof patch[key] !== "string")
      throw new Error(t("mcp.correctField", { field: key }))
  if ("enabled" in patch && typeof patch.enabled !== "boolean")
    throw new Error(t("mcp.enabledInvalid"))
  if ("timeout" in patch && (typeof patch.timeout !== "number" || !Number.isFinite(patch.timeout)))
    throw new Error(t("mcp.timeoutInvalid"))
  for (const [key, options] of [
    ["type", ["stdio", "http", "streamable-http"]],
    ["exposure", ["codemode", "direct", "hidden"]],
  ] as const)
    if (key in patch && !options.some((option) => option === patch[key]))
      throw new Error(t("mcp.correctField", { field: key }))
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
    throw new Error(t("mcp.timeoutPositive"))
  for (const scope of ["env", "headers"] as const) {
    const map = config[scope]
    if (
      map !== undefined &&
      (!map ||
        typeof map !== "object" ||
        Array.isArray(map) ||
        Object.values(map).some((value) => value !== null))
    )
      throw new Error(t("mcp.maskedRequired"))
    if (Object.keys(secrets[scope]).length)
      config[scope] = { ...(map ?? previous?.[scope] ?? {}), ...secrets[scope] }
  }
  return config
}

/** Field operations only. Never include values, including legacy command or URL secrets. */
export function mcpChangePreview(patch: McpPatch, previous?: Inventory["mcp"][number]) {
  const actionKeys = {
    Preserved: "mcp.preview.preserved",
    Replaced: "mcp.preview.replaced",
    Added: "mcp.preview.added",
    Removed: "mcp.preview.removed",
    Cleared: "mcp.preview.cleared",
    "Set / replaced": "mcp.preview.setReplaced",
    Set: "mcp.preview.set",
    "Removed / inferred": "mcp.preview.inferred",
  } as const satisfies Record<string, MessageKey>
  const operations: { field: string; name?: string; action: keyof typeof actionKeys }[] = []
  const add = (field: string, action: keyof typeof actionKeys, name?: string) =>
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
      .map(({ field, name, action }) =>
        t(actionKeys[action], { field: `${field}${name !== undefined ? `.${name}` : ""}` }),
      ),
    ...removed
      .filter(
        (key) =>
          known.has(key) ||
          key in patch ||
          (key === "env" && Object.keys(previous?.env ?? {}).length > 0) ||
          (key === "headers" && Object.keys(previous?.headers ?? {}).length > 0),
      )
      .map((key) => t("mcp.preview.transportRemoved", { field: key })),
  ]
}

export function McpGuidedEditor({
  text,
  onChange,
  existing = true,
  savedTransport,
}: {
  existing?: boolean
  savedTransport?: "http" | "stdio"
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
      throw new Error(t("mcp.argumentsInvalid"))
  } catch (error) {
    return (
      <InlineAlert variant="negative">
        <Content>{error instanceof Error ? error.message : t("mcp.guidedUnavailable")}</Content>
      </InlineAlert>
    )
  }
  const set = (key: string, value: unknown) =>
    onChange(JSON.stringify({ ...patch, [key]: value }, null, 2))
  const omit = (key: string) => {
    const next = { ...patch }
    delete next[key]
    onChange(JSON.stringify(next, null, 2))
  }
  const transport =
    patch.url !== undefined ? "http" : patch.command !== undefined ? "stdio" : savedTransport
  const fields = (advanced: boolean) => (
    <div className="mcp-field-grid">
      {(["command", "url", "cwd", "description", "timeout", "enabled", "exposure", "type"] as const)
        .filter((key) => advanced === !["command", "url", "enabled"].includes(key))
        .filter((key) => key !== "command" || transport === "stdio")
        .filter((key) => key !== "url" || transport === "http")
        .map((key) => (
          <div key={key} className="mcp-field">
            {(existing || advanced) && (
              <Check
                id={`${prefix}-${key}-edit`}
                label={t("mcp.editField", { field: key })}
                describedBy={existing ? `${prefix}-replacement-help` : undefined}
                checked={key in patch}
                onChange={(checked) =>
                  checked
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
                visibleLabel={t(existing ? "mcp.replaceField" : "mcp.setField", { field: key })}
              />
            )}
            {key in patch &&
              (key === "enabled" ? (
                <Check
                  id={`${prefix}-enabled-value`}
                  label={t("mcp.enabledValue")}
                  checked={patch.enabled === true}
                  onChange={(value) => set(key, value)}
                  visibleLabel={t("mcp.enabledAfterSave")}
                />
              ) : key === "exposure" || key === "type" ? (
                <label className="mcp-field-value" htmlFor={`${prefix}-${key}-value`}>
                  {existing ? t("mcp.replacementField", { field: key }) : key}
                  <SectionPicker
                    value={String(patch[key])}
                    onValueChange={(value) => set(key, value)}
                    id={`${prefix}-${key}-value`}
                    aria-label={t("mcp.fieldReplacement", { field: key })}
                  >
                    {(key === "exposure"
                      ? ["codemode", "direct", "hidden"]
                      : ["stdio", "http", "streamable-http"]
                    ).map((value) => (
                      <PickerOption key={value} id={value}>
                        {key === "exposure"
                          ? t(`mcp.exposure.${value as "codemode" | "direct" | "hidden"}`)
                          : value}
                      </PickerOption>
                    ))}
                  </SectionPicker>
                </label>
              ) : (
                <div className="mcp-field-value">
                  <label htmlFor={`${prefix}-${key}-value`}>
                    {key === "url"
                      ? "URL"
                      : key === "command"
                        ? t("mcp.command")
                        : t("mcp.replacementField", { field: key })}
                  </label>
                  <TextField
                    id={`${prefix}-${key}-value`}
                    aria-label={
                      key === "url"
                        ? t("mcp.connectionUrl")
                        : key === "command"
                          ? t("mcp.connectionCommand")
                          : t("mcp.fieldReplacement", { field: key })
                    }
                    type={key === "timeout" ? "number" : "text"}
                    value={String(patch[key] ?? "")}
                    onChange={(value) => set(key, key === "timeout" ? Number(value) : value)}
                    styles={fullWidth}
                  />
                </div>
              ))}
          </div>
        ))}
    </div>
  )
  return (
    <fieldset
      className="mcp-guided-editor"
      id="mcp-guided"
      tabIndex={-1}
      aria-labelledby={`${prefix}-heading`}
    >
      <legend className="visually-hidden" id={`${prefix}-heading`}>
        {t("mcp.connectionDetails")}
      </legend>
      {existing && (
        <Prose size="2" id={`${prefix}-replacement-help`}>
          {t("mcp.replacementHelp")}
        </Prose>
      )}
      <label className="mcp-guided-toolbar" htmlFor={`${prefix}-transport`}>
        {t("mcp.connectionType")}
        <SectionPicker
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
          id={`${prefix}-transport`}
          aria-label={t("mcp.connectionType")}
        >
          {existing && <PickerOption id="preserve">{t("mcp.keepTransport")}</PickerOption>}
          <PickerOption id="stdio">
            {existing ? t("mcp.replaceStdio") : t("mcp.stdioCommand")}
          </PickerOption>
          <PickerOption id="http">
            {existing ? t("mcp.replaceHttp") : t("mcp.httpEndpoint")}
          </PickerOption>
        </SectionPicker>
      </label>
      {fields(false)}
      <details className="mcp-optional-fields">
        <summary>{t("mcp.advancedFields")}</summary>
        {fields(true)}
      </details>
      <div hidden={transport !== "stdio"} className="mcp-arguments">
        <h4 className={style({ font: "heading-xs" })}>{t("mcp.arguments")}</h4>
        {(Array.isArray(patch.args) ? (patch.args as string[]) : []).map((arg, index) => (
          // Arguments are controlled positional fields with no row state; additions append only.
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: Argument position is the field identity.
            key={`${prefix}-${index}`}
            className="mcp-argument-row"
          >
            <div className="mcp-argument-input">
              <label htmlFor={`${prefix}-arg-${index}`}>
                {t("mcp.argument", { number: index + 1 })}
              </label>
              <TextField
                id={`${prefix}-arg-${index}`}
                aria-label={t("mcp.argumentLabel", { number: index + 1 })}
                styles={fullWidth}
                value={arg}
                onChange={(value) =>
                  set(
                    "args",
                    (patch.args as string[]).map((v, i) => (i === index ? value : v)),
                  )
                }
              />
            </div>
            <Button
              variant="secondary"
              onPress={() =>
                set(
                  "args",
                  (patch.args as string[]).filter((_, i) => i !== index),
                )
              }
            >
              <Delete aria-hidden="true" />
              {t("mcp.removeArgument", { number: index + 1 })}
            </Button>
          </div>
        ))}
        <div className={argumentActions}>
          <Button
            variant="secondary"
            onPress={() => set("args", [...(Array.isArray(patch.args) ? patch.args : []), ""])}
          >
            <Add aria-hidden="true" />
            {t("mcp.addArgument")}
          </Button>
          {existing && "args" in patch && (
            <Button variant="secondary" onPress={() => omit("args")}>
              {t("mcp.keepArguments")}
            </Button>
          )}
        </div>
      </div>
    </fieldset>
  )
}
