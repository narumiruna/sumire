import { Button, Flex, Text } from "@radix-ui/themes"
import { useState } from "react"
import type { ProviderSettings } from "./api.js"
import { Check, Field } from "./policy-editors.js"
import { SectionSelect as Select } from "./sections.js"
import { Panel, Prose } from "./surfaces.js"

export function ProviderEditor({
  onAdd,
  initial,
  onPending,
  onDiscard,
}: {
  onDiscard(): void
  onPending(value: boolean): void
  onAdd(provider: ProviderSettings): void
  initial?: ProviderSettings
}) {
  const [id, setId] = useState(initial?.id ?? "")
  const [url, setUrl] = useState(initial?.baseUrl ?? "")
  const [api, setApi] = useState<ProviderSettings["api"]>(initial?.api ?? "openai-completions")
  const [models, setModels] = useState<ProviderSettings["models"]>(initial?.models ?? [])
  const [model, setModel] = useState("")
  const [name, setName] = useState("")
  const [reasoning, setReasoning] = useState(false)
  const [image, setImage] = useState(false)
  const [context, setContext] = useState("128000")
  const [output, setOutput] = useState("8192")
  const workingModels = () =>
    model
      ? [
          ...models.filter((m) => m.id !== model),
          {
            id: model,
            name: name || model,
            reasoning,
            image,
            contextWindow: Number(context),
            maxTokens: Number(output),
          },
        ]
      : models
  return (
    <Panel as="fieldset" onChangeCapture={() => onPending(true)}>
      <legend>{initial ? "Edit provider configuration" : "Add provider configuration"}</legend>
      <Field label="Provider ID" value={id} onChange={setId} />
      <Field label="API base URL" value={url} onChange={setUrl} />
      <details className="provider-advanced">
        <summary>Advanced protocol</summary>
        <label htmlFor="provider-api">
          API
          <Select.Root
            value={api}
            onValueChange={(v) => {
              onPending(true)
              setApi(v as ProviderSettings["api"])
            }}
          >
            <Select.Trigger id="provider-api" aria-label="API" />
            <Select.Content>
              {[
                "openai-completions",
                "openai-responses",
                "anthropic-messages",
                "google-generative-ai",
              ].map((v) => (
                <Select.Item key={v} value={v}>
                  {v}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </label>
      </details>
      {models.map((m) => (
        <Panel key={m.id}>
          <Text>
            {m.name} · {m.id} · context {m.contextWindow}
          </Text>
          <Flex gap="2">
            <Button
              variant="soft"
              onClick={() => {
                setModel(m.id)
                setName(m.name)
                setReasoning(m.reasoning)
                setImage(m.image)
                setContext(String(m.contextWindow))
                setOutput(String(m.maxTokens))
              }}
            >
              Edit model {m.id}
            </Button>
            <Button
              variant="soft"
              color="red"
              onClick={() => {
                onPending(true)
                setModels(models.filter((row) => row.id !== m.id))
                if (model === m.id) {
                  setModel("")
                  setName("")
                }
              }}
            >
              Remove model {m.id}
            </Button>
          </Flex>
        </Panel>
      ))}
      <Field label="Model ID (required for custom endpoint)" value={model} onChange={setModel} />
      <details className="provider-advanced">
        <summary>Advanced model metadata</summary>
        <Field label="Model display name" value={name} onChange={setName} />
        <Check
          label="Reasoning supported"
          checked={reasoning}
          onChange={(v) => {
            onPending(true)
            setReasoning(v)
          }}
        />
        <Check
          label="Image input supported"
          checked={image}
          onChange={(v) => {
            onPending(true)
            setImage(v)
          }}
        />
        <Field label="Context window tokens" value={context} onChange={setContext} />
        <Field label="Maximum output tokens" value={output} onChange={setOutput} />
      </details>
      <Flex gap="2" wrap="wrap">
        <Button
          variant="soft"
          disabled={!model}
          onClick={() => {
            onPending(true)
            setModels(workingModels())
            setModel("")
            setName("")
          }}
        >
          Add / update model
        </Button>
        <Button
          disabled={!id}
          onClick={() =>
            onAdd({
              id,
              enabled: initial?.enabled ?? true,
              ...(url ? { baseUrl: url, api } : {}),
              models: workingModels(),
            })
          }
        >
          Set provider configuration
        </Button>
        <Button variant="soft" onClick={onDiscard}>
          Discard custom endpoint draft
        </Button>
      </Flex>
      <Prose size="2">
        This stages policy edits only. Apply policy changes before authentication. This replaces the
        custom model list. Custom model costs are unknown, not verified zero-cost.
      </Prose>
    </Panel>
  )
}
