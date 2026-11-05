import { MagnifyingGlassIcon } from "@radix-ui/react-icons"
import * as VisuallyHidden from "@radix-ui/react-visually-hidden"
import { Badge, Button, Code, Flex, Table, Text, TextField } from "@radix-ui/themes"
import { useEffect, useId, useState } from "react"
import { type Policy, parseIds } from "./api.js"
import { type Chat, chatName } from "./chats.js"
import { t } from "./i18n.js"
import { withChatAccess } from "./policy-changes.js"
import { Panel, Prose, SettingsSection } from "./surfaces.js"

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
  const searchId = useId()
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
      <label className="form-field access-list__search" htmlFor={searchId}>
        {t(positive ? "access.searchPrivate" : "access.searchGroups")}
        <TextField.Root
          id={searchId}
          value={query}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value)
            setPage(0)
          }}
        >
          <TextField.Slot>
            <MagnifyingGlassIcon aria-hidden="true" />
          </TextField.Slot>
        </TextField.Root>
      </label>
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
      <Table.Root size="1" className="access-table">
        <VisuallyHidden.Root asChild>
          <caption>{label}</caption>
        </VisuallyHidden.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell scope="col">{t("access.chatId")}</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell scope="col">{t("access.access")}</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell scope="col">{t("access.action")}</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {visible.map((id) => {
            const known = metadata.get(id)
            const removed = revoked.includes(id)
            return (
              <Table.Row key={id} className={removed ? "access-row--revoked" : undefined}>
                <Table.Cell>
                  <Prose weight="medium">
                    {known
                      ? chatName(known)
                      : t(id > 0 ? "access.unnamedPrivate" : "access.unnamedGroup")}
                  </Prose>
                  <Code size="2" variant="ghost" className="access-id">
                    {id}
                  </Code>
                </Table.Cell>
                <Table.Cell>
                  <Badge
                    color={removed || pending.includes(id) ? "orange" : "green"}
                    variant="soft"
                  >
                    {removed
                      ? t("access.pendingRevocation")
                      : pending.includes(id)
                        ? t("access.pendingApproval")
                        : t("access.approved")}
                  </Badge>
                </Table.Cell>
                <Table.Cell>
                  {removed ? (
                    <Button variant="soft" onClick={() => onChange([...values, id])}>
                      {t("access.undoRevocation", { id })}
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      color="red"
                      aria-label={t("access.revokeId", { id })}
                      onClick={() => onChange(values.filter((value) => value !== id))}
                    >
                      {t("access.revoke")}
                    </Button>
                  )}
                </Table.Cell>
              </Table.Row>
            )
          })}
        </Table.Body>
      </Table.Root>
      {lastPage > 0 && (
        <Flex
          gap="2"
          mt="3"
          wrap="wrap"
          aria-label={t(positive ? "access.privatePages" : "access.groupPages")}
        >
          <Button
            variant="soft"
            aria-label={t(positive ? "access.previousPrivate" : "access.previousGroups")}
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            {t("access.previous")}
          </Button>
          <Button
            variant="soft"
            aria-label={t(positive ? "access.nextPrivate" : "access.nextGroups")}
            disabled={currentPage === lastPage}
            onClick={() => setPage(currentPage + 1)}
          >
            {t("access.next")}
          </Button>
        </Flex>
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
    <Flex direction="column" gap="4">
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
          <Flex gap="3" align="end" wrap="wrap" className="access-list__add">
            <label className="form-field" htmlFor="access-id-input">
              {t("access.idInput")}
              <TextField.Root
                id="access-id-input"
                value={draft}
                autoComplete="off"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "access-id-error" : undefined}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setError("")
                  onPending(Boolean(event.target.value))
                }}
              />
            </label>
            <Button type="submit" disabled={!draft}>
              {t("access.reviewApproval")}
            </Button>
            {draft && (
              <Button
                type="button"
                variant="soft"
                onClick={() => {
                  setDraft("")
                  setError("")
                  onPending(false)
                }}
              >
                {t("access.clearInput")}
              </Button>
            )}
          </Flex>
          {error && (
            <Text as="p" id="access-id-error" role="alert" color="red" size="2">
              {t(error)}
            </Text>
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
    </Flex>
  )
}
