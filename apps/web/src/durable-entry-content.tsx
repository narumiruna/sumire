import type { DurableEntryItem } from "@narumitw/sumire-contracts"
import { Button, Text } from "@react-spectrum/s2/Button"
import Chat from "@react-spectrum/s2/icons/Chat"
import Copy from "@react-spectrum/s2/icons/Copy"
import { useState } from "react"
import { type MessageKey, t } from "./i18n.js"

function CopyContent({ text }: { text: string }) {
  const [status, setStatus] = useState<MessageKey>()
  return (
    <>
      <Button
        type="button"
        UNSAFE_className="durable-copy-button"
        aria-label={t("record.copyContent")}
        size="S"
        variant="secondary"
        fillStyle="outline"
        onPress={() => {
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(text))
            .then(
              () => setStatus("record.contentCopied"),
              () => setStatus("record.copyContentFailed"),
            )
        }}
      >
        <Copy aria-hidden />
        <Text UNSAFE_className="durable-copy-label">{t("record.copyContent")}</Text>
      </Button>
      {status && <span role="status">{t(status)}</span>}
    </>
  )
}

export function EntryContent({
  content,
  toolName,
  collapseTools = false,
}: {
  content: NonNullable<DurableEntryItem["content"]>
  toolName?: string
  collapseTools?: boolean
}) {
  const roles = {
    system: t("record.system"),
    user: t("record.user"),
    assistant: t("record.assistant"),
    toolResult: t("record.toolResult"),
  }
  return (
    <section aria-label={t("record.entryContent")} className="durable-entry-content">
      {content.truncated && <p role="status">{t("record.contentTruncatedDetails")}</p>}
      {content.messages.length === 0 && (
        <p>{content.truncated ? t("record.noMessagesIncluded") : t("record.noMessages")}</p>
      )}
      {content.messages.map((message, index) => (
        <section
          // biome-ignore lint/suspicious/noArrayIndexKey: A read-only message snapshot has no message IDs.
          key={index}
          aria-label={t("record.messageNumber", { number: index + 1 })}
          className="durable-entry-message"
        >
          <div className="durable-message-heading">
            <Chat aria-hidden />
            <h4>
              {content.messages.length > 1
                ? roles[message.role]
                : message.role === "toolResult"
                  ? t("record.output")
                  : t("record.message")}
            </h4>
            {message.toolName !== undefined &&
              (content.messages.length > 1 || message.toolName !== toolName) && (
                <span>{message.toolName}</span>
              )}
            {(message.role === "toolResult" || message.isError !== undefined) && (
              <span className="durable-tree-badge">
                {message.isError === undefined
                  ? t("record.resultMissing")
                  : message.isError
                    ? t("record.recordedError")
                    : t("record.recordedResult")}
              </span>
            )}
            {message.content.some(
              (block) => block.type === "text" || block.type === "toolCall",
            ) && (
              <CopyContent
                text={message.content
                  .flatMap((block) =>
                    block.type === "text"
                      ? [block.text]
                      : block.type === "toolCall"
                        ? [block.arguments]
                        : [],
                  )
                  .join("\n\n")}
              />
            )}
          </div>
          {message.content.length === 0 && (
            <p>{content.truncated ? t("record.noBlocksIncluded") : t("record.noBlocks")}</p>
          )}
          {message.content.map((block, blockIndex) => {
            switch (block.type) {
              case "text":
                return message.role === "toolResult" ? (
                  collapseTools ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Content blocks have no IDs in this snapshot.
                    <details key={blockIndex}>
                      <summary>{t("record.toolOutput")}</summary>
                      <pre className="durable-tool-output">{block.text}</pre>
                    </details>
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Content blocks have no IDs in this snapshot.
                    <pre className="durable-tool-output" key={blockIndex}>
                      {block.text}
                    </pre>
                  )
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Content blocks have no IDs in this snapshot.
                  <p className="durable-message-text" key={blockIndex}>
                    {block.text}
                  </p>
                )
              case "thinking":
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Content blocks have no IDs and cannot be reordered in this snapshot.
                  <details key={blockIndex}>
                    <summary>{t("record.thinking")}</summary>
                    <p className="durable-message-text">{block.thinking}</p>
                  </details>
                )
              case "toolCall": {
                const Container = collapseTools ? "details" : "section"
                return (
                  <Container
                    // biome-ignore lint/suspicious/noArrayIndexKey: Content blocks have no IDs and cannot be reordered in this snapshot.
                    key={blockIndex}
                    aria-label={t("record.toolCall")}
                    className="durable-tool-call"
                  >
                    {collapseTools && (
                      <summary>{t("record.argumentsForTool", { name: block.name })}</summary>
                    )}
                    <div className="durable-message-heading">
                      <h5>{t("record.argumentsForTool", { name: block.name })}</h5>
                      <span>{t("record.jsonText")}</span>
                    </div>
                    <pre className="durable-arguments">{block.arguments}</pre>
                    <details className="durable-message-details">
                      <summary>{t("record.toolCallDetails")}</summary>
                      <dl className="durable-metadata">
                        <dt>{t("record.toolName")}</dt>
                        <dd>{block.name}</dd>
                        <dt>{t("record.callId")}</dt>
                        <dd>{block.id}</dd>
                      </dl>
                    </details>
                  </Container>
                )
              }
              case "image":
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Content blocks have no IDs and cannot be reordered in this snapshot.
                  <p key={blockIndex}>{t("record.imageOmitted", { mimeType: block.mimeType })}</p>
                )
              default:
                return null
            }
          })}
          {message.toolCallId !== undefined && (
            <details className="durable-message-details">
              <summary>{t("record.messageDetails")}</summary>
              <dl className="durable-metadata">
                <dt>{t("record.callId")}</dt>
                <dd>{message.toolCallId}</dd>
              </dl>
            </details>
          )}
        </section>
      ))}
    </section>
  )
}
