import type { DurableEntryItem } from "@narumitw/sumire-contracts"
import { ChatBubbleIcon, CopyIcon } from "@radix-ui/react-icons"
import { Button, Heading, Text } from "@radix-ui/themes"
import { useState } from "react"

function CopyContent({ text }: { text: string }) {
  const [status, setStatus] = useState("")
  return (
    <>
      <Button
        type="button"
        size="1"
        variant="outline"
        onClick={() => {
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(text))
            .then(
              () => setStatus("Content copied."),
              () => setStatus("Copy failed. Select and copy the content below."),
            )
        }}
      >
        <CopyIcon aria-hidden /> Copy content
      </Button>
      {status && (
        <Text size="1" role="status">
          {status}
        </Text>
      )}
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
    system: "System",
    user: "User",
    assistant: "Assistant",
    toolResult: "Tool result",
  }
  return (
    <section aria-label="Entry content" className="durable-entry-content">
      {content.truncated && (
        <Text as="p" role="status">
          Content truncated · inspection limits were reached. Messages, blocks, or text may be
          incomplete.
        </Text>
      )}
      {content.messages.length === 0 && (
        <Text as="p">
          {content.truncated
            ? "No message content included in this response."
            : "No message content recorded."}
        </Text>
      )}
      {content.messages.map((message, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: A read-only message snapshot has no message IDs.
        <section key={index} aria-label={`Message ${index + 1}`} className="durable-entry-message">
          <div className="durable-message-heading">
            <ChatBubbleIcon aria-hidden />
            <Heading as="h4" size="2">
              {content.messages.length > 1
                ? roles[message.role]
                : message.role === "toolResult"
                  ? "Output"
                  : "Message"}
            </Heading>
            {message.toolName !== undefined &&
              (content.messages.length > 1 || message.toolName !== toolName) && (
                <span>{message.toolName}</span>
              )}
            {(message.role === "toolResult" || message.isError !== undefined) && (
              <span className="durable-tree-badge">
                {message.isError === undefined
                  ? "Result not recorded"
                  : message.isError
                    ? "Recorded error"
                    : "Recorded result · not an error"}
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
            <Text as="p">
              {content.truncated
                ? "No content blocks included in this response."
                : "No content blocks recorded."}
            </Text>
          )}
          {message.content.map((block, blockIndex) => {
            switch (block.type) {
              case "text":
                return message.role === "toolResult" ? (
                  collapseTools ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Content blocks have no IDs in this snapshot.
                    <details key={blockIndex}>
                      <summary>Tool output</summary>
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
                    <summary>Thinking</summary>
                    <p className="durable-message-text">{block.thinking}</p>
                  </details>
                )
              case "toolCall": {
                const Container = collapseTools ? "details" : "section"
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Content blocks have no IDs and cannot be reordered in this snapshot.
                  <Container key={blockIndex} aria-label="Tool call">
                    {collapseTools && <summary>{block.name} · Arguments</summary>}
                    <div className="durable-message-heading">
                      <Heading as="h5" size="2">
                        {block.name} · Arguments
                      </Heading>
                      <span>JSON text</span>
                    </div>
                    <pre className="durable-arguments">{block.arguments}</pre>
                    <details className="durable-message-details">
                      <summary>Tool call details</summary>
                      <dl className="durable-metadata">
                        <dt>Tool name</dt>
                        <dd>{block.name}</dd>
                        <dt>Call ID</dt>
                        <dd>{block.id}</dd>
                      </dl>
                    </details>
                  </Container>
                )
              }
              case "image":
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Content blocks have no IDs and cannot be reordered in this snapshot.
                  <Text as="p" key={blockIndex}>
                    Image omitted · {block.mimeType}. Image bytes are not sent.
                  </Text>
                )
              default:
                return null
            }
          })}
          {message.toolCallId !== undefined && (
            <details className="durable-message-details">
              <summary>Message details</summary>
              <dl className="durable-metadata">
                <dt>Call ID</dt>
                <dd>{message.toolCallId}</dd>
              </dl>
            </details>
          )}
        </section>
      ))}
    </section>
  )
}
