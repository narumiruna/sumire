import type { Chat } from "@narumitw/sumire-contracts"
import { Button } from "@react-spectrum/s2/Button"
import { TextField } from "@react-spectrum/s2/TextField"
import { useEffect, useState } from "react"
import { type Policy, parseIds } from "./api.js"
import { ChatSearchField, chatName } from "./chat-directory.js"
import { t } from "./i18n.js"
import { withChatAccess } from "./policy-changes.js"
import { Panel, Prose, SettingsSection, StatusLabel } from "./surfaces.js"

const pageSize = 20

function IdList({
  label,
  values,
  savedValues,
  target,
  chats,
  positive,
  onChange,
}: {
  label: string
  values: number[]
  savedValues: number[]
  target: string
  chats: Chat[]
  positive: boolean
  onChange(values: number[]): void
}) {
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(0)
  useEffect(() => {
    setQuery(target && Number(target) > 0 === positive ? target : "")
    setPage(0)
  }, [target, positive])
  const metadata = new Map(chats.map((chat) => [chat.id, chat]))
  const revoked = savedValues.filter((id) => !values.includes(id))
  const pending = values.filter((id) => !savedValues.includes(id))
  const matches = [...values, ...revoked].filter((id) =>
    `${metadata.get(id)?.name ?? ""} ${id}`.toLowerCase().includes(query.toLowerCase()),
  )
  const lastPage = Math.max(0, Math.ceil(matches.length / pageSize) - 1)
  const currentPage = Math.min(page, lastPage)
  const offset = currentPage * pageSize
  const visible = matches.slice(offset, offset + pageSize)
  return (
    <Panel
      as="fieldset"
      className="access-list"
      id={positive ? "access-users-list" : "access-groups-list"}
      tabIndex={-1}
    >
      <legend>{label}</legend>
      <div className="access-list__search">
        <ChatSearchField
          label={t(positive ? "access.searchPrivate" : "access.searchGroups")}
          value={query}
          autoComplete="off"
          onChange={(value) => {
            setQuery(value)
            setPage(0)
          }}
        />
      </div>
      <Prose size="2" color="gray" className="access-list__summary" aria-live="polite">
        {t(
          pending.length > 0
            ? revoked.length > 0
              ? "access.summaryBoth"
              : "access.summaryApproval"
            : revoked.length > 0
              ? "access.summaryRevocation"
              : "access.summary",
          {
            range: matches.length
              ? t("access.range", {
                  start: offset + 1,
                  end: offset + visible.length,
                  count: matches.length,
                })
              : t("access.noMatches"),
            pending: pending.length,
            revoked: revoked.length,
          },
        )}
      </Prose>
      <table className="access-table">
        <caption className="visually-hidden">{label}</caption>
        <thead>
          <tr>
            <th scope="col">{t("access.chatId")}</th>
            <th scope="col">{t("access.access")}</th>
            <th scope="col">{t("access.action")}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((id) => {
            const known = metadata.get(id)
            const removed = revoked.includes(id)
            return (
              <tr key={id} className={removed ? "access-row--revoked" : undefined}>
                <td>
                  <Prose weight="medium">
                    {known
                      ? chatName(known)
                      : t(id > 0 ? "access.unnamedPrivate" : "access.unnamedGroup")}
                  </Prose>
                  <code className="access-id">{id}</code>
                </td>
                <td>
                  <StatusLabel tone={removed || pending.includes(id) ? "warning" : "success"}>
                    {removed
                      ? t("access.pendingRevocation")
                      : pending.includes(id)
                        ? t("access.pendingApproval")
                        : t("access.approved")}
                  </StatusLabel>
                </td>
                <td>
                  {removed ? (
                    <Button size="XL" variant="secondary" onPress={() => onChange([...values, id])}>
                      {t("access.undoRevocation", { id })}
                    </Button>
                  ) : (
                    <Button
                      size="XL"
                      variant="negative"
                      fillStyle="outline"
                      aria-label={t("access.revokeId", { id })}
                      onPress={() => onChange(values.filter((value) => value !== id))}
                    >
                      {t("access.revoke")}
                    </Button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {lastPage > 0 && (
        <nav
          className="chat-control-row access-list__pages"
          aria-label={t(positive ? "access.privatePages" : "access.groupPages")}
        >
          <Button
            size="XL"
            variant="secondary"
            aria-label={t(positive ? "access.previousPrivate" : "access.previousGroups")}
            isDisabled={currentPage === 0}
            onPress={() => setPage(currentPage - 1)}
          >
            {t("access.previous")}
          </Button>
          <Button
            size="XL"
            variant="secondary"
            aria-label={t(positive ? "access.nextPrivate" : "access.nextGroups")}
            isDisabled={currentPage === lastPage}
            onPress={() => setPage(currentPage + 1)}
          >
            {t("access.next")}
          </Button>
        </nav>
      )}
    </Panel>
  )
}

export function ChatAccess({
  policy,
  saved,
  target,
  chats,
  onChange,
  onPending,
  onReview,
}: {
  policy: Policy
  saved: Policy
  target: string
  chats: Chat[]
  onChange(value: Policy): void
  onPending(value: boolean): void
  onReview(): void
}) {
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<"" | "access.duplicate" | "access.invalidId">("")
  return (
    <div className="chat-access">
      <SettingsSection
        title={t("access.approveTitle")}
        description={t("access.approveDescription")}
      >
        <form
          className="access-approve-form"
          aria-label={t("access.approveLabel")}
          onSubmit={(event) => {
            event.preventDefault()
            try {
              const ids = parseIds(draft, Number(draft.trim()) > 0)
              const [id] = ids
              if (ids.length !== 1 || id === undefined) throw new Error(t("access.invalidId"))
              if ((id > 0 ? policy.privateUsers : policy.groups).includes(id)) {
                setError("access.duplicate")
                return
              }
              onChange(withChatAccess(policy, id, true))
              setDraft("")
              setError("")
              onPending(false)
              onReview()
            } catch {
              setError("access.invalidId")
            }
          }}
        >
          <div className="chat-control-row access-list__add">
            <TextField
              UNSAFE_className="access-list__input"
              id="access-id-input"
              label={t("access.idInput")}
              size="XL"
              value={draft}
              autoComplete="off"
              isInvalid={Boolean(error)}
              aria-describedby={error ? "access-id-error" : undefined}
              onChange={(value) => {
                setDraft(value)
                setError("")
                onPending(Boolean(value))
              }}
            />
            <Button variant="accent" size="XL" type="submit" isDisabled={!draft}>
              {t("access.reviewApproval")}
            </Button>
            {draft && (
              <Button
                type="button"
                size="XL"
                variant="secondary"
                onPress={() => {
                  setDraft("")
                  setError("")
                  onPending(false)
                }}
              >
                {t("access.clearInput")}
              </Button>
            )}
          </div>
          {error && (
            <Prose id="access-id-error" role="alert" className="chat-field-error">
              {t(error)}
            </Prose>
          )}
        </form>
      </SettingsSection>
      <div className="access-lists">
        <IdList
          label={t("access.privateAccess")}
          positive
          values={policy.privateUsers}
          savedValues={saved.privateUsers}
          target={target}
          chats={chats}
          onChange={(values) => onChange({ ...policy, privateUsers: values })}
        />
        <IdList
          label={t("access.groupAccess")}
          positive={false}
          values={policy.groups}
          savedValues={saved.groups}
          target={target}
          chats={chats}
          onChange={(values) => onChange({ ...policy, groups: values })}
        />
      </div>
      <details className="access-search-help">
        <summary>{t("access.searchHelpTitle")}</summary>
        <Prose size="2">{t("access.searchHelp")}</Prose>
      </details>
    </div>
  )
}
