import {
  ChatBubbleIcon,
  CheckCircledIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CodeIcon,
  FileTextIcon,
  GearIcon,
  InfoCircledIcon,
  LayersIcon,
  LockClosedIcon,
  MixerHorizontalIcon,
  ReloadIcon,
  PersonIcon,
} from "@radix-ui/react-icons"
import { Theme } from "@radix-ui/themes"
import { type ReactNode, useEffect, useRef } from "react"
import { createRoot } from "react-dom/client"
import "@radix-ui/themes/styles.css"
import "../../src/styles.css"
import "./durable-visual-preview.css"

const fixturePath = "/tests/fixtures/durable-visual-preview.html"
const scenarioHref = (record: "user" | "tool") => `${fixturePath}?record=${record}`
const toolSelected = new URLSearchParams(window.location.search).get("record") !== "user"
const selectedId = toolSelected ? 71 : 70
const userText = "Read README.md and summarize the setup steps."
const output = `# Project setup
1. Install Node.js 26 or newer.
2. Run npm ci.
3. Copy .env.example to .env.
4. Run npm run dev.`
const args = {
  script: 'const readme = await tools.read({ path: "README.md" });\nconsole.log(readme);',
}
const rawRecord = {
  id: selectedId,
  conversationId: 7,
  taskId: toolSelected ? 81 : 8,
  role: toolSelected ? "toolResult" : "user",
  ...(toolSelected ? { toolName: "codemode", arguments: args } : {}),
  content: toolSelected ? output : userText,
}

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="dv-disclosure">
      <summary>
        <ChevronRightIcon className="dv-chevron" aria-hidden />
        {title}
      </summary>
      <div className="dv-disclosure-body">{children}</div>
    </details>
  )
}

function Sidebar() {
  return (
    <aside className="sidebar dv-sidebar" aria-label="Administration navigation">
      <div className="brand dv-brand">
        <GearIcon aria-hidden /> Sumire
      </div>
      <span className="dv-sidebar-caption">Administration</span>
      <nav aria-label="Administration sections">
        {[
          "Chats",
          "Durable",
          "Access",
          "Defaults",
          "Tool permissions",
          "MCP connections",
          "Model providers",
          "Audit",
        ].map((label) =>
          label === "Durable" ? (
            <a key={label} href={scenarioHref(toolSelected ? "tool" : "user")} aria-current="page">
              {label}
            </a>
          ) : (
            <button key={label} type="button" disabled title="Not connected in this static preview">
              {label}
            </button>
          ),
        )}
      </nav>
      <div className="sidebar-account dv-account">
        <div className="dv-avatar" aria-hidden>
          PV
        </div>
        <div>
          <strong>Preview administrator</strong>
          <span>Synthetic actor · read-only</span>
        </div>
      </div>
      <span className="dv-mobile-section">Administration / Durable</span>
    </aside>
  )
}

function Branch({
  label,
  id,
  icon,
  badge,
  recordRole,
  snippet,
  children,
}: {
  label: string
  id: number
  icon: ReactNode
  badge?: string
  recordRole: "conversation" | "assistant" | "call"
  snippet: string
  children: ReactNode
}) {
  return (
    <li>
      <details className={`dv-branch dv-role-${recordRole}`} open>
        <summary aria-label={`Toggle ${label} ${id} records`}>
          <ChevronRightIcon className="dv-chevron" aria-hidden />
          <span className="dv-role-icon">{icon}</span>
          <span className="dv-row-body">
            <span className="dv-row-heading">
              <span className="dv-row-label">{label}</span>
              <span className="dv-record-id">#{id}</span>
            </span>
            <span className="dv-row-caption">
              <span className="dv-row-snippet">{snippet}</span>
              {badge && <span className="dv-tree-badge">{badge}</span>}
            </span>
          </span>
        </summary>
        <ul>{children}</ul>
      </details>
    </li>
  )
}

function RecordLink({ record }: { record: "user" | "tool" }) {
  const isTool = record === "tool"
  const selected = isTool === toolSelected
  return (
    <li className={`dv-leaf dv-role-${isTool ? "result" : "user"}`}>
      <a href={scenarioHref(record)} aria-current={selected ? "page" : undefined}>
        <span className="dv-chevron-space" aria-hidden />
        <span className="dv-role-icon">
          {isTool ? <LayersIcon aria-hidden /> : <PersonIcon aria-hidden />}
        </span>
        <span className="dv-row-body">
          <span className="dv-row-heading">
            <span className="dv-row-label">{isTool ? "Tool result" : "User message"}</span>
            <span className="dv-record-id">#{isTool ? 71 : 70}</span>
          </span>
          <span className="dv-row-caption">
            <span className="dv-row-snippet">
              {isTool
                ? toolSelected
                  ? "Project setup"
                  : "codemode"
                : toolSelected
                  ? "Recorded user input"
                  : userText}
            </span>
            <time dateTime={`2026-10-20T10:24:${isTool ? "08" : "00"}Z`}>
              10:24:{isTool ? "08" : "00"}
            </time>
          </span>
        </span>
      </a>
    </li>
  )
}

function RecordBrowser() {
  const disclosure = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1100px)")
    const sync = () => {
      if (disclosure.current) disclosure.current.open = desktop.matches
    }
    sync()
    desktop.addEventListener("change", sync)
    return () => desktop.removeEventListener("change", sync)
  }, [])
  return (
    <details
      ref={disclosure}
      className="dv-browser"
      open={window.matchMedia("(min-width: 1100px)").matches}
    >
      <summary className="dv-browse-trigger">
        <LayersIcon aria-hidden />
        <span>Browse records</span>
        <span className="dv-browse-current">Entry {selectedId}</span>
        <ChevronDownIcon className="dv-chevron" aria-hidden />
      </summary>
      <nav className="dv-navigator" aria-label="Record navigator">
        <div className="dv-navigator-heading">
          <span className="dv-navigator-title">
            <LayersIcon aria-hidden /> Records
          </span>
          <span className="dv-count">5 loaded</span>
        </div>
        <ul className="dv-records">
          <Branch
            label="Conversation"
            id={7}
            icon={<ChatBubbleIcon aria-hidden />}
            badge="Persisted"
            recordRole="conversation"
            snippet="Build review"
          >
            <Branch
              label="Model response"
              id={8}
              icon={<ChatBubbleIcon aria-hidden />}
              recordRole="assistant"
              snippet="Model task"
            >
              <RecordLink record="user" />
              <Branch
                label="codemode"
                id={81}
                icon={<CodeIcon aria-hidden />}
                badge="Returned"
                recordRole="call"
                snippet="Tool call"
              >
                <RecordLink record="tool" />
              </Branch>
            </Branch>
          </Branch>
        </ul>
        <div className="dv-navigator-footer">
          <Disclosure title="About these records">
            <p>
              Only loaded records are shown. This is a synthetic relationship sample, not a complete
              history. Conversation 7 is the persisted selection; the highlighted entry is the
              record being inspected.
            </p>
            <p>Parent rows expand branches. Entry links open the two static preview scenarios.</p>
          </Disclosure>
        </div>
      </nav>
    </details>
  )
}

function SelectedRecord() {
  return (
    <article
      className={`dv-detail dv-role-${toolSelected ? "result" : "user"}`}
      aria-label="Selected record"
    >
      <header className="dv-detail-header">
        <div className="dv-detail-identity">
          <span className="dv-detail-icon dv-role-icon">
            {toolSelected ? <LayersIcon aria-hidden /> : <PersonIcon aria-hidden />}
          </span>
          <div className="dv-detail-titles">
            <div className="dv-detail-kind">
              <span className="dv-eyebrow">{toolSelected ? "Tool result" : "User"}</span>
              <span className="dv-record-id">Entry {selectedId}</span>
            </div>
            <h2>{toolSelected ? "codemode" : "User message"}</h2>
          </div>
          {toolSelected && (
            <span className="dv-result-status">
              <CheckCircledIcon aria-hidden /> Succeeded
            </span>
          )}
        </div>
        <div className="dv-record-meta">
          <p className="dv-relationships">
            Conversation <code>7</code> <ChevronRightIcon aria-hidden /> Task <code>8</code>
            {toolSelected && (
              <>
                <ChevronRightIcon aria-hidden /> Task <code>81</code>
              </>
            )}
          </p>
          <time dateTime={`2026-10-20T10:24:${toolSelected ? "08" : "00"}Z`}>
            Oct 20 · 10:24:{toolSelected ? "08" : "00"} UTC
          </time>
        </div>
      </header>
      <div className="dv-record-content">
        {toolSelected ? (
          <>
            <div className="dv-section-heading">
              <h3>
                <FileTextIcon aria-hidden /> Output
              </h3>
              <span className="dv-format-label">text/plain</span>
            </div>
            <pre className="dv-output">{output}</pre>
            <div className="dv-arguments-section dv-role-call">
              <div className="dv-section-heading">
                <h3>
                  <CodeIcon aria-hidden /> Arguments
                </h3>
                <span className="dv-format-label">script · string</span>
              </div>
              <pre className="dv-arguments">{args.script}</pre>
            </div>
          </>
        ) : (
          <>
            <div className="dv-section-heading">
              <h3>
                <ChatBubbleIcon aria-hidden /> Message
              </h3>
              <span className="dv-format-label">text</span>
            </div>
            <p className="dv-message-text">{userText}</p>
          </>
        )}
      </div>
      <div className="dv-technical">
        {toolSelected && (
          <Disclosure title="Thinking">
            <p>No thinking content is included in this synthetic fixture.</p>
          </Disclosure>
        )}
        <Disclosure title="Record details">
          <dl className="dv-metadata">
            <dt>Record</dt>
            <dd>Entry {selectedId}</dd>
            <dt>Conversation</dt>
            <dd>7</dd>
            <dt>Task</dt>
            <dd>{toolSelected ? 81 : 8}</dd>
            <dt>Role</dt>
            <dd>{toolSelected ? "toolResult" : "user"}</dd>
            <dt>Source</dt>
            <dd>Synthetic fixture · no live data</dd>
          </dl>
        </Disclosure>
        <Disclosure title="Raw data">
          <p>Static JSON. Select the text to copy it manually.</p>
          <pre className="dv-raw">{JSON.stringify(rawRecord, null, 2)}</pre>
          <button className="dv-button" type="button" disabled>
            Copy JSON · preview only
          </button>
        </Disclosure>
      </div>
      <footer className="dv-detail-footer">
        <LockClosedIcon aria-hidden /> Read-only record · synthetic content
      </footer>
    </article>
  )
}

function Preview() {
  return (
    <div className="admin-shell dv-preview">
      <Sidebar />
      <main>
        <div className="dv-preview-label">
          <span className="dv-preview-tag">Static design preview</span>
          <span>Synthetic data only</span>
          <span className="dv-preview-label-detail">Not connected to Admin API</span>
        </div>
        <header className="dv-page-header">
          <div className="dv-page-identity">
            <span className="dv-app-icon">
              <LayersIcon aria-hidden />
            </span>
            <div>
              <div className="dv-breadcrumb">Administration / Durable</div>
              <h1>Durable Inspector</h1>
            </div>
          </div>
          <div className="dv-header-actions">
            <span className="dv-readonly">
              <LockClosedIcon aria-hidden /> Read-only
            </span>
            <div className="dv-action-group">
              <button
                className="dv-button"
                type="button"
                disabled
                title="Not connected in this static preview"
              >
                <ReloadIcon aria-hidden /> Refresh
              </button>
              <button
                className="dv-button"
                type="button"
                disabled
                title="Not connected in this static preview"
              >
                <MixerHorizontalIcon aria-hidden /> Switch chat
              </button>
            </div>
          </div>
        </header>
        <div className="dv-chat-context">
          <span className="dv-chat-icon">
            <ChatBubbleIcon aria-hidden />
          </span>
          <div className="dv-chat-name">
            <strong>Build review</strong>
            <span>Chat 42</span>
          </div>
          <div className="dv-context-labels">
            <span className="dv-context-selection">
              <span className="dv-context-key">Inspecting</span>
              <strong>
                Conversation <code>7</code>
              </strong>
            </span>
            <span className="dv-context-selection">
              <span className="dv-context-key">Persisted selection</span>
              <strong>
                Conversation <code>7</code>
              </strong>
            </span>
          </div>
        </div>
        <section className="dv-workspace" aria-label="Preview workspace">
          <RecordBrowser />
          <SelectedRecord />
        </section>
        <div className="dv-secondary-tools">
          <Disclosure title="History and lookup">
            <p>Preview sample: Conversation 7, Task 8, Task 81, and Entries 70–71.</p>
            <p>Live history, direct-ID lookup, and collection browsing are not connected.</p>
            <button className="dv-button" type="button" disabled>
              Look up record
            </button>
          </Disclosure>
          <Disclosure title="Data scope">
            <p>
              This preview uses synthetic records only. No requests are sent to the model or Admin
              API. Refresh, chat switching, and other Admin sections are disabled.
            </p>
          </Disclosure>
        </div>
        <footer className="dv-page-footer">
          <InfoCircledIcon aria-hidden /> Static design preview · synthetic data · not the
          production UI
        </footer>
      </main>
    </div>
  )
}

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <Theme appearance="light" accentColor="teal" grayColor="sand" radius="medium">
      <Preview />
    </Theme>,
  )
}
