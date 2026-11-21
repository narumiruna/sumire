import { PlusIcon } from "@radix-ui/react-icons"
import { Badge, Button, Code, Flex, Grid, Text } from "@radix-ui/themes"
import { useState } from "react"
import type { ProviderSettings } from "./api.js"
import { t } from "./i18n.js"
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
    <Panel
      as="fieldset"
      className="provider-editor settings-stack"
      onChangeCapture={() => onPending(true)}
    >
      <legend>{initial ? t("provider.editConfiguration") : t("provider.addConfiguration")}</legend>
      <Grid columns={{ initial: "1", md: "2" }} gap="3" className="settings-grid">
        <Field id="endpoint-provider-id" label={t("provider.id")} value={id} onChange={setId} />
        <Field label={t("provider.baseUrl")} value={url} onChange={setUrl} />
      </Grid>
      <details className="provider-advanced">
        <summary>{t("provider.protocol")}</summary>
        <label htmlFor="provider-api" className="form-field">
          {t("provider.api")}
          <Select.Root
            value={api}
            onValueChange={(v) => {
              onPending(true)
              setApi(v as ProviderSettings["api"])
            }}
          >
            <Select.Trigger id="provider-api" aria-label={t("provider.api")} />
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
      {models.length > 0 && (
        <section className="data-list" aria-label={t("provider.customModels")}>
          {models.map((m) => (
            <div className="data-row" key={m.id}>
              <Flex direction="column" gap="2">
                <Flex align="center" gap="2" wrap="wrap">
                  <Text size="2" weight="medium">
                    {m.name}
                  </Text>
                  <Code size="1">{m.id}</Code>
                </Flex>
                <Flex gap="2" wrap="wrap">
                  <Badge color="gray">{t("model.contextValue", { count: m.contextWindow })}</Badge>
                  <Badge color="gray">{t("model.outputValue", { count: m.maxTokens })}</Badge>
                  {m.reasoning && <Badge color="gray">{t("model.reasoning")}</Badge>}
                  {m.image && <Badge color="gray">{t("model.imageInput")}</Badge>}
                </Flex>
              </Flex>
              <Flex gap="2" wrap="wrap">
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
                  {t("model.editNamed", { id: m.id })}
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
                  {t("model.removeNamed", { id: m.id })}
                </Button>
              </Flex>
            </div>
          ))}
        </section>
      )}
      <Field label={t("model.endpointId")} value={model} onChange={setModel} />
      <details className="provider-advanced">
        <summary>{t("model.metadata")}</summary>
        <Field label={t("model.displayName")} value={name} onChange={setName} />
        <Flex gap="4" wrap="wrap" my="3">
          <Check
            label={t("model.reasoningSupported")}
            checked={reasoning}
            onChange={(v) => {
              onPending(true)
              setReasoning(v)
            }}
          />
          <Check
            label={t("model.imageSupported")}
            checked={image}
            onChange={(v) => {
              onPending(true)
              setImage(v)
            }}
          />
        </Flex>
        <Grid columns={{ initial: "1", md: "2" }} gap="3" className="settings-grid">
          <Field label={t("model.contextTokens")} value={context} onChange={setContext} />
          <Field label={t("model.outputTokens")} value={output} onChange={setOutput} />
        </Grid>
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
          <PlusIcon /> {t("model.update")}
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
          {t("provider.setConfiguration")}
        </Button>
        <Button variant="soft" onClick={onDiscard}>
          {t("provider.discardEndpoint")}
        </Button>
      </Flex>
      <Prose size="2" color="gray" className="section-copy">
        {t("provider.stageHelp")}
      </Prose>
    </Panel>
  )
}
