import type { DurableEntryItem } from "@narumitw/sumire-contracts"
import { FileTextIcon } from "@radix-ui/react-icons"
import { Heading } from "@radix-ui/themes"
import { EntryContent } from "./durable-entry-content.js"
import { formatDurableTime, recordIcon, recordTitle, recordTone } from "./durable-presentation.js"
import { t } from "./i18n.js"

export type ReadingBlock =
  | { type: "message"; entry: DurableEntryItem }
  | { type: "events"; entries: DurableEntryItem[] }

/** Presentation grouping only: never infer a sender's authority from saved text. */
export function readingBlocks(entries: readonly DurableEntryItem[]): ReadingBlock[] {
  const blocks: ReadingBlock[] = []
  for (const entry of entries) {
    const message =
      entry.kind === "pi.user" ||
      (entry.role === "assistant" &&
        entry.content?.messages.some(
          (item) =>
            item.role === "assistant" && item.content.some((block) => block.type === "text"),
        ))
    if (message) blocks.push({ type: "message", entry })
    else {
      const previous = blocks.at(-1)
      if (previous?.type === "events") previous.entries.push(entry)
      else blocks.push({ type: "events", entries: [entry] })
    }
  }
  return blocks
}

export function ReadingEntries({
  entries,
  conversationId,
  selectedId,
  entryHref,
  onInspect,
  preview,
}: {
  entries: readonly DurableEntryItem[]
  conversationId: number
  selectedId?: number
  entryHref(id: number): string
  onInspect(id: number, opener: HTMLAnchorElement): void
  preview(entry: DurableEntryItem): string
}) {
  const renderEntry = (entry: DurableEntryItem) => {
    const Icon = recordIcon(entry)
    return (
      <article
        key={entry.id}
        className={`reading-entry durable-role-${recordTone(entry)}`}
        data-selected={selectedId === entry.id}
      >
        <header className="reading-entry-header">
          <span className="reading-avatar durable-role-icon">
            <Icon aria-hidden />
          </span>
          <div className="reading-entry-identity">
            <Heading as="h4" size="3">
              {recordTitle(entry)}
            </Heading>
            {entry.timestamp !== undefined && <time>{formatDurableTime(entry.timestamp)}</time>}
          </div>
          <a
            className="reading-inspect-link"
            href={entryHref(entry.id)}
            aria-label={t("record.inspectEntry", { id: entry.id })}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return
              event.preventDefault()
              onInspect(entry.id, event.currentTarget)
            }}
          >
            <FileTextIcon aria-hidden />
            <span>#{entry.id}</span>
          </a>
        </header>
        {entry.conversationId !== conversationId && (
          <p className="durable-preview-note">
            {t("record.inherited", { id: entry.conversationId })}
          </p>
        )}
        {entry.content ? (
          <EntryContent content={entry.content} toolName={entry.toolName} collapseTools />
        ) : (
          <p className="durable-message-text">{preview(entry)}</p>
        )}
        <details className="reading-entry-metadata">
          <summary>{t("record.recordDetails")}</summary>
          <dl className="durable-metadata">
            <dt>{t("record.conversationId")}</dt>
            <dd>{entry.conversationId}</dd>
            <dt>{t("record.storedKind")}</dt>
            <dd>{entry.kind}</dd>
          </dl>
        </details>
      </article>
    )
  }
  return (
    <div className="reading-transcript">
      {readingBlocks(entries).map((block) =>
        block.type === "message" ? (
          renderEntry(block.entry)
        ) : (
          <details key={`events-${block.entries[0]?.id}`} className="reading-system-events">
            <summary>{t("record.systemEvents", { count: block.entries.length })}</summary>
            <div>{block.entries.map(renderEntry)}</div>
          </details>
        ),
      )}
    </div>
  )
}
