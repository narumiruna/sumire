import type {
  RuntimeConfigEntry,
  RuntimeConfigMutation,
  RuntimeConfigResponse,
} from "@narumitw/sumire-contracts"
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Flex,
  Heading,
  Tabs,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes"
import { useEffect, useRef, useState } from "react"
import { ApiError, request } from "./api.js"
import { parseRuntimeConfig, runtimeValueError } from "./runtime-config-state.js"
import { Panel, Prose } from "./surfaces.js"

type Draft = { name: string; kind: "secret" | "variable"; value: string; existing: boolean }
type Props = {
  csrf: string
  blocked: boolean
  revision: number
  onPending(value: boolean): void
  guard: React.MutableRefObject<(() => boolean) | undefined>
  onCommitted(value: RuntimeConfigResponse): void
  onSessionExpired(): void
  refresh(): Promise<void>
}

export function RuntimeConfig({
  csrf,
  blocked,
  revision,
  onPending,
  guard,
  onCommitted,
  onSessionExpired,
  refresh,
}: Props) {
  const [data, setData] = useState<RuntimeConfigResponse>()
  const [kind, setKind] = useState<"secret" | "variable">("secret")
  const [search, setSearch] = useState("")
  const [draft, setDraft] = useState<Draft>()
  const [deleting, setDeleting] = useState<RuntimeConfigEntry>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [recovery, setRecovery] = useState(false)
  const [notice, setNotice] = useState("")
  const generation = useRef(0)
  const alert = useRef<HTMLDivElement>(null)
  const focusTarget = useRef<"runtime-name" | "runtime-value" | "runtime-add">(undefined)
  const clear = () => {
    setDraft(undefined)
  }
  const canLeave = () => {
    if (busy) return false
    if (draft && !window.confirm("Discard the runtime value draft and leave?")) return false
    clear()
    return true
  }
  guard.current = canLeave
  const pending = Boolean(draft) || busy || recovery
  useEffect(() => onPending(pending), [onPending, pending])
  useEffect(
    () => () => {
      generation.current++
      guard.current = undefined
      onPending(false)
    },
    [guard, onPending],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: Opening or closing a draft must move focus after its fields mount.
  useEffect(() => {
    if (error && !deleting) alert.current?.focus()
    else if (!busy && focusTarget.current) {
      document.getElementById(focusTarget.current)?.focus()
      focusTarget.current = undefined
    }
  }, [error, busy, deleting, draft])
  const load = async () => {
    const version = generation.current
    setBusy(true)
    setError("")
    try {
      const next = parseRuntimeConfig(await request<RuntimeConfigResponse>("runtime-config"))
      if (version !== generation.current) return
      setData(next)
      setRecovery(false)
    } catch (failure) {
      if (version !== generation.current) return
      if (failure instanceof ApiError && failure.status === 401) onSessionExpired()
      else setError("Could not load safe runtime metadata. No value was submitted.")
    } finally {
      if (version === generation.current) setBusy(false)
    }
  }
  // The section is unmounted on navigation or session expiry; late results cannot restore drafts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Load once per mounted session section.
  useEffect(() => {
    void load()
  }, [])
  const mutate = async (name: string, mutation?: RuntimeConfigMutation) => {
    if (!data || blocked || recovery || busy || data.revision !== revision) return
    const version = generation.current
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const committed = parseRuntimeConfig(
        await request<RuntimeConfigResponse>(
          `runtime-config/${encodeURIComponent(name)}`,
          csrf,
          mutation ?? { revision: data.revision },
          mutation ? "PUT" : "DELETE",
        ),
      )
      if (committed.revision <= data.revision) throw new Error("Unverified save")
      if (version !== generation.current) return
      // Persistence succeeded, including when application failed. Never resubmit the value.
      clear()
      setDeleting(undefined)
      setData(committed)
      onCommitted(committed)
      focusTarget.current = "runtime-add"
      setNotice(
        committed.status === "applied" && committed.applied === committed.revision
          ? "Saved and applied."
          : committed.status === "failed"
            ? "Saved; application failed. Retry application above without submitting the value again."
            : "Saved. Application is pending; check application status above.",
      )
      try {
        await refresh()
      } catch (failure) {
        if (version !== generation.current) return
        if (failure instanceof ApiError && failure.status === 401) onSessionExpired()
        else
          setError(
            "The value was saved, but related settings could not be refreshed. Reload metadata; do not repeat the save.",
          )
      }
    } catch (failure) {
      if (version !== generation.current) return
      if (failure instanceof ApiError && failure.status === 401) onSessionExpired()
      else {
        setDeleting(undefined)
        setRecovery(true)
        setError(
          failure instanceof ApiError && failure.status === 409
            ? "The revision conflicts with current configuration, or a connection test is active. No automatic retry will occur. Reload safe metadata before deciding on another replacement."
            : "The save could not be verified. It may already be saved. No automatic retry will occur. Reload safe metadata before deciding on another replacement.",
        )
      }
    } finally {
      if (version === generation.current) setBusy(false)
    }
  }
  const stale = Boolean(data && data.revision !== revision)
  const unavailable = kind === "secret" && data?.secretStatus !== "ready"
  const disabled = busy || blocked || recovery || stale
  const start = (entry?: RuntimeConfigEntry) => {
    focusTarget.current = entry ? "runtime-value" : "runtime-name"
    setError("")
    setNotice("")
    setDraft({
      name: entry?.name ?? "",
      kind,
      value: entry?.kind === "variable" ? entry.value : "",
      existing: Boolean(entry),
    })
  }
  return (
    <div className="settings-stack runtime-config" aria-busy={busy}>
      <Tabs.Root
        value={kind}
        onValueChange={(value) => {
          if (!canLeave()) return
          setDeleting(undefined)
          setKind(value as "secret" | "variable")
          setSearch("")
        }}
      >
        <Tabs.List aria-label="Runtime value kinds">
          <Tabs.Trigger value="secret">Secrets</Tabs.Trigger>
          <Tabs.Trigger value="variable">Variables</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value={kind} className="settings-stack">
          <Prose>
            {kind === "secret"
              ? "Saved secrets are write-only. Only names, configured state, and update times are shown. Enter a new value only to create or replace a secret."
              : "Variables are not confidential. Authorized chats with read_variable can read all variables in this installation. Returned values can remain in conversation history. Do not store credentials here."}
          </Prose>
          {kind === "secret" && (
            <Prose>
              For GitHub CLI, create a secret named GH_TOKEN with a GitHub.com Personal Access
              Token. Once saved and applied, the token is available to the next bash execution
              without restart. All chats with bash access can use and read the token; give bash only
              to trusted chats. Configured state does not prove that GitHub accepts the token.
            </Prose>
          )}
          {data?.secretStatus !== "ready" && data && (
            <Callout.Root color="orange" role="status">
              <Callout.Text>
                {data.secretStatus === "locked"
                  ? "Secret store locked. Restore the matching ENCRYPTION_KEY through trusted host configuration and restart. Do not change the key independently of the database."
                  : "Secret store unavailable. Configure a valid ENCRYPTION_KEY through trusted host configuration and restart."}{" "}
                Variable management remains available.
              </Callout.Text>
            </Callout.Root>
          )}
          {blocked && (
            <Prose>
              Save or discard pending policy, MCP, or other editor drafts before changing runtime
              values.
            </Prose>
          )}
          {stale && <Prose>Configuration changed. Reload safe metadata before editing.</Prose>}
          {error && (
            <Callout.Root ref={alert} tabIndex={-1} role="alert" color="red">
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}
          {notice && <Text role="status">{notice}</Text>}
          <Flex gap="3" wrap="wrap">
            <Button
              id="runtime-add"
              disabled={!data || disabled || unavailable || Boolean(draft)}
              onClick={() => start()}
            >
              Add {kind}
            </Button>
            <Button
              variant="soft"
              disabled={busy || blocked}
              onClick={() => {
                if (
                  draft &&
                  !window.confirm(
                    "Discard this draft and reload safe metadata? A previous save may already have committed.",
                  )
                )
                  return
                clear()
                const version = generation.current
                void load().then(async () => {
                  if (version !== generation.current) return
                  try {
                    await refresh()
                  } catch (failure) {
                    if (version !== generation.current) return
                    if (failure instanceof ApiError && failure.status === 401) onSessionExpired()
                    else
                      setError("Could not refresh shared application status. Reload before saving.")
                  }
                })
              }}
            >
              Reload safe metadata
            </Button>
          </Flex>
          {draft && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                const message = runtimeValueError(draft.name, draft.kind, draft.value)
                if (message) {
                  setError(message)
                  return
                }
                if (!draft.existing && data?.entries.some((entry) => entry.name === draft.name)) {
                  setError(
                    "This name already exists. Use Replace or Edit for the saved entry. To change its kind, delete it first; variables are not confidential.",
                  )
                  return
                }
                if (data)
                  void mutate(draft.name, {
                    revision: data.revision,
                    kind: draft.kind,
                    value: draft.value,
                  })
              }}
            >
              <Panel>
                <Heading size="3">
                  {draft.existing
                    ? kind === "secret"
                      ? "Replace secret"
                      : "Edit variable"
                    : `Add ${kind}`}
                </Heading>
                <label htmlFor="runtime-name">
                  Name
                  <TextField.Root
                    id="runtime-name"
                    value={draft.name}
                    disabled={draft.existing || busy}
                    autoComplete="off"
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <label htmlFor="runtime-value">
                  {kind === "secret" ? "Runtime secret value" : "Variable value"}
                  {kind === "secret" ? (
                    <TextField.Root
                      id="runtime-value"
                      type="password"
                      autoComplete="new-password"
                      value={draft.value}
                      disabled={busy}
                      onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                    />
                  ) : (
                    <TextArea
                      id="runtime-value"
                      value={draft.value}
                      disabled={busy}
                      onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                    />
                  )}
                </label>
                <Flex gap="3" wrap="wrap" mt="3">
                  <Button
                    type="submit"
                    disabled={disabled || unavailable || (kind === "secret" && !draft.value)}
                  >
                    Save {kind}
                  </Button>
                  <Button
                    type="button"
                    variant="soft"
                    disabled={busy}
                    onClick={() => {
                      focusTarget.current = "runtime-add"
                      clear()
                      if (!recovery) setError("")
                    }}
                  >
                    Cancel
                  </Button>
                </Flex>
              </Panel>
            </form>
          )}
          <label htmlFor="runtime-search">
            Search names
            <TextField.Root
              id="runtime-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {data ? (
            data.entries
              .filter((entry) => entry.kind === kind && entry.name.includes(search.toUpperCase()))
              .map((entry) => (
                <Panel key={entry.name} aria-label={`${entry.name} ${kind}`}>
                  <Heading as="h2" size="3" className="runtime-entry-name">
                    {entry.name}
                  </Heading>
                  {entry.kind === "secret" ? (
                    <Badge>Configured · ••••••••</Badge>
                  ) : (
                    <pre className="runtime-variable-value">{entry.value}</pre>
                  )}
                  <Text as="p" size="2">
                    Updated: {new Date(entry.updatedAt).toLocaleString()}
                  </Text>
                  <Flex gap="3" wrap="wrap">
                    <Button
                      variant="soft"
                      disabled={disabled || unavailable || Boolean(draft)}
                      onClick={() => start(entry)}
                    >
                      {kind === "secret" ? "Replace" : "Edit"} {entry.name}
                    </Button>
                    <Button
                      variant="soft"
                      color="red"
                      disabled={disabled || unavailable || Boolean(draft)}
                      onClick={() => setDeleting(entry)}
                    >
                      Delete {entry.name}
                    </Button>
                  </Flex>
                </Panel>
              ))
          ) : (
            <Text role="status">Loading runtime metadata…</Text>
          )}
          <AlertDialog.Root
            open={Boolean(deleting)}
            onOpenChange={(open) => {
              if (!open) setDeleting(undefined)
            }}
          >
            <AlertDialog.Content
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                document.getElementById("runtime-add")?.focus()
              }}
            >
              <AlertDialog.Title>Delete {deleting?.name}?</AlertDialog.Title>
              <AlertDialog.Description>
                Delete this {deleting?.kind} and apply the change? Remove saved MCP references
                first. Deletion does not erase backups or conversation history and does not revoke
                an upstream key. To change a secret into a public variable, delete it first and
                explicitly create a variable.
              </AlertDialog.Description>
              <Flex gap="3" mt="4">
                <AlertDialog.Cancel>
                  <Button variant="soft">Cancel</Button>
                </AlertDialog.Cancel>
                <AlertDialog.Action>
                  <Button
                    color="red"
                    disabled={disabled}
                    onClick={() => {
                      if (deleting) void mutate(deleting.name)
                    }}
                  >
                    Delete and apply
                  </Button>
                </AlertDialog.Action>
              </Flex>
            </AlertDialog.Content>
          </AlertDialog.Root>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}
