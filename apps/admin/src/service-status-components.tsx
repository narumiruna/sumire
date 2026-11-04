import type { ServiceStatusCatalog, ServiceStatusComponent } from "@narumitw/sumire-contracts"
import { type StatusProviderId, statusProviderIds } from "@narumitw/sumire-policy"
import { Badge, Button, Code, Flex, Text, TextField } from "@radix-ui/themes"
import { useContext, useEffect, useRef, useState } from "react"
import { ApiError, request } from "./api.js"
import { Check } from "./policy-editors.js"
import { SectionActive, SectionSelect as Select } from "./sections.js"
import { statusProviderNames } from "./status-notifications.js"
import { Panel, Prose } from "./surfaces.js"

type Selections = Partial<Record<StatusProviderId, string[] | null>>

/** Search only the bounded published catalog. Labels never determine stored IDs or hierarchy. */
export function matchingStatusComponents(components: ServiceStatusComponent[], query: string) {
  const search = query.toLowerCase().trim()
  const names = new Map(components.map((component) => [component.id, component.name]))
  return components.filter((component) =>
    [component.id, component.name, component.groupId ? names.get(component.groupId) : ""].some(
      (value) => value?.toLowerCase().includes(search),
    ),
  )
}

export function StatusComponents({
  prefix,
  selections,
  inherited,
  disabled,
  onChange,
  onSessionExpired,
}: {
  prefix: string
  selections: Selections
  inherited?: Selections
  disabled: boolean
  onChange(selections: Selections): void
  onSessionExpired(): void
}) {
  const active = useContext(SectionActive)
  const [provider, setProvider] = useState<StatusProviderId>("github")
  const [query, setQuery] = useState("")
  const [catalogs, setCatalogs] = useState<Partial<Record<StatusProviderId, ServiceStatusCatalog>>>(
    {},
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [refresh, setRefresh] = useState(0)
  const [selecting, setSelecting] = useState<StatusProviderId>()
  const callback = useRef(onSessionExpired)
  callback.current = onSessionExpired
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is an explicit catalog reload trigger.
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setLoading(true)
    setError("")
    void request<ServiceStatusCatalog>(
      `service-status/components?provider=${provider}`,
      undefined,
      undefined,
      "GET",
      controller.signal,
    )
      .then(
        (catalog) => {
          if (!controller.signal.aborted)
            setCatalogs((current) => ({ ...current, [provider]: catalog }))
        },
        (failure) => {
          if (controller.signal.aborted) return
          if (failure instanceof ApiError && failure.status === 401) callback.current()
          else
            setError(
              "Could not load this component catalog. Your selections have not changed. Refresh to try again.",
            )
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [active, provider, refresh])
  const catalog = catalogs[provider]
  const components = catalog?.components ?? []
  const own = selections[provider]
  const inherits = inherited !== undefined && own === undefined
  const selected = inherits ? (inherited[provider] ?? null) : (own ?? null)
  const mode = inherits
    ? "inherit"
    : selected === null
      ? "all"
      : selected.length || selecting === provider
        ? "selected"
        : "none"
  const setSelection = (value: string[] | null | undefined) => {
    const next = { ...selections }
    if (value === undefined) delete next[provider]
    else next[provider] = value
    onChange(next)
  }
  const matches = matchingStatusComponents(components, query)
  const published = new Map(components.map((component) => [component.id, component]))
  return (
    <Panel as="fieldset" id={`${prefix}-components`} tabIndex={-1} className="status-components">
      <legend>Components and groups</legend>
      <Prose size="2">
        Use published component or group IDs. A selected group includes its published descendants.
        No region or product is inferred from a name. Select each service separately, including
        services not enabled yet.
      </Prose>
      <Flex gap="3" wrap="wrap" align="end">
        <label className="form-field" htmlFor={`${prefix}-component-service`}>
          Component service
          <Select.Root
            value={provider}
            onValueChange={(value) => {
              setProvider(value as StatusProviderId)
              setQuery("")
            }}
          >
            <Select.Trigger id={`${prefix}-component-service`} aria-label="Component service" />
            <Select.Content>
              {statusProviderIds.map((id) => (
                <Select.Item key={id} value={id}>
                  {statusProviderNames[id]}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </label>
        <label className="form-field" htmlFor={`${prefix}-component-mode`}>
          Component coverage
          <Select.Root
            value={mode}
            disabled={disabled}
            onValueChange={(value) => {
              setSelecting(value === "selected" ? provider : undefined)
              setSelection(
                value === "inherit"
                  ? undefined
                  : value === "all"
                    ? null
                    : value === "selected" && selected
                      ? selected
                      : [],
              )
            }}
          >
            <Select.Trigger id={`${prefix}-component-mode`} aria-label="Component coverage" />
            <Select.Content>
              {inherited !== undefined && (
                <Select.Item value="inherit">Inherit shared selection</Select.Item>
              )}
              <Select.Item value="all">All components</Select.Item>
              <Select.Item value="none">No components</Select.Item>
              <Select.Item value="selected">Selected components or groups</Select.Item>
            </Select.Content>
          </Select.Root>
        </label>
        <Button variant="soft" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          Refresh component catalog
        </Button>
      </Flex>
      {inherits && (
        <Prose size="2">
          Inherited coverage:{" "}
          {selected === null ? "all components" : `${selected.length} selected IDs`}. Choose another
          coverage mode to override this service.
        </Prose>
      )}
      <Text as="p" size="2" role="status">
        {loading
          ? "Loading component catalog…"
          : catalog?.fetchedAt
            ? `Catalog fetched ${new Date(catalog.fetchedAt).toLocaleString()}.`
            : "No current catalog available."}
        {catalog?.stale && " Catalog is stale; selections are retained."}
        {catalog?.error && " Source unavailable; selections are retained."}
      </Text>
      {error && (
        <Prose role="alert" color="red">
          {error}
        </Prose>
      )}
      {selected !== null && (
        <>
          <Prose size="2">
            Incidents without a known component association do not match an explicit selection. A
            provider-wide status alone cannot establish a selected component's outage or recovery.
          </Prose>
          <Text as="p" size="2">
            {selected.length} selected IDs · maximum 128 per service selection, 512 across status
            settings.
          </Text>
          <ul className="status-component-list" aria-label="Selected component IDs">
            {selected.map((id) => {
              const component = published.get(id)
              return (
                <li key={id}>
                  <span>
                    {component?.name ?? "Unavailable component"} <Code variant="ghost">{id}</Code>{" "}
                    {component?.isGroup && <Badge>Group</Badge>}{" "}
                    {!component && <Badge color="orange">Unavailable ID retained</Badge>}
                  </span>
                  {!inherits && (
                    <Button
                      variant="soft"
                      disabled={disabled}
                      aria-label={`Remove component ${id}`}
                      onClick={() => setSelection(selected.filter((value) => value !== id))}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
      {mode === "selected" && !inherits && (
        <>
          <label className="form-field" htmlFor={`${prefix}-component-search`}>
            Search components and published groups
            <TextField.Root
              id={`${prefix}-component-search`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
            />
          </label>
          <Text as="p" size="2" color="gray">
            {matches.length} matches. Showing up to 100. Search to narrow the catalog.
          </Text>
          <fieldset className="status-component-matches">
            <legend>Component catalog matches</legend>
            {matches.slice(0, 100).map((component) => (
              <div key={component.id}>
                <Check
                  label={`${component.name} · ${component.id}`}
                  checked={selected?.includes(component.id) ?? false}
                  disabled={
                    disabled ||
                    ((selected?.length ?? 0) >= 128 && !selected?.includes(component.id))
                  }
                  onChange={(checked) =>
                    setSelection(
                      checked
                        ? [...(selected ?? []), component.id]
                        : (selected ?? []).filter((id) => id !== component.id),
                    )
                  }
                />
                <Text as="p" size="1" color="gray">
                  {component.isGroup ? "Published group" : component.status}
                  {component.groupId &&
                    ` · Group: ${published.get(component.groupId)?.name ?? component.groupId}`}
                </Text>
              </div>
            ))}
            {!matches.length && (
              <Prose size="2">
                No matching published components. Existing selected IDs stay selected.
              </Prose>
            )}
          </fieldset>
        </>
      )}
    </Panel>
  )
}
