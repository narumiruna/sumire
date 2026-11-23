import { Badge } from "@react-spectrum/s2/Badge"
import { Button } from "@react-spectrum/s2/Button"
import Add from "@react-spectrum/s2/icons/Add"
import { TextField } from "@react-spectrum/s2/TextField"
import { useState } from "react"
import type { ProviderSettings } from "./api.js"
import { Check } from "./check.js"
import { t } from "./i18n.js"
import { PickerOption, SectionPicker } from "./section-picker.js"
import { Panel, Prose } from "./surfaces.js"
import "./provider-spectrum.css"

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
      <div className="provider-fields">
        <TextField
          id="endpoint-provider-id"
          label={t("provider.id")}
          value={id}
          onChange={setId}
          autoComplete="off"
          size="XL"
        />
        <TextField
          label={t("provider.baseUrl")}
          value={url}
          onChange={setUrl}
          autoComplete="off"
          size="XL"
        />
      </div>
      <details className="provider-advanced">
        <summary>{t("provider.protocol")}</summary>
        <label htmlFor="provider-api" className="form-field">
          {t("provider.api")}
          <SectionPicker
            value={api}
            onValueChange={(v) => {
              onPending(true)
              setApi(v as ProviderSettings["api"])
            }}
            id="provider-api"
            aria-label={t("provider.api")}
          >
            {[
              "openai-completions",
              "openai-responses",
              "anthropic-messages",
              "google-generative-ai",
            ].map((v) => (
              <PickerOption key={v} id={v}>
                {v}
              </PickerOption>
            ))}
          </SectionPicker>
        </label>
      </details>
      {models.length > 0 && (
        <section className="data-list" aria-label={t("provider.customModels")}>
          {models.map((m) => (
            <div className="data-row" key={m.id}>
              <div className="provider-model-facts">
                <div className="provider-controls">
                  <strong>{m.name}</strong>
                  <code>{m.id}</code>
                </div>
                <div className="provider-controls">
                  <Badge variant="neutral" fillStyle="subtle">
                    {t("model.contextValue", { count: m.contextWindow })}
                  </Badge>
                  <Badge variant="neutral" fillStyle="subtle">
                    {t("model.outputValue", { count: m.maxTokens })}
                  </Badge>
                  {m.reasoning && (
                    <Badge variant="neutral" fillStyle="subtle">
                      {t("model.reasoning")}
                    </Badge>
                  )}
                  {m.image && (
                    <Badge variant="neutral" fillStyle="subtle">
                      {t("model.imageInput")}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="provider-controls">
                <Button
                  variant="secondary"
                  size="XL"
                  onPress={() => {
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
                  variant="negative"
                  fillStyle="outline"
                  size="XL"
                  onPress={() => {
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
              </div>
            </div>
          ))}
        </section>
      )}
      <TextField
        label={t("model.endpointId")}
        value={model}
        onChange={setModel}
        autoComplete="off"
        size="XL"
      />
      <details className="provider-advanced">
        <summary>{t("model.metadata")}</summary>
        <TextField
          label={t("model.displayName")}
          value={name}
          onChange={setName}
          autoComplete="off"
          size="XL"
        />
        <div className="provider-controls">
          <Check
            checked={reasoning}
            onChange={(v) => {
              onPending(true)
              setReasoning(v)
            }}
            label={t("model.reasoningSupported")}
          />
          <Check
            checked={image}
            onChange={(v) => {
              onPending(true)
              setImage(v)
            }}
            label={t("model.imageSupported")}
          />
        </div>
        <div className="provider-fields">
          <TextField
            label={t("model.contextTokens")}
            value={context}
            onChange={setContext}
            autoComplete="off"
            size="XL"
          />
          <TextField
            label={t("model.outputTokens")}
            value={output}
            onChange={setOutput}
            autoComplete="off"
            size="XL"
          />
        </div>
      </details>
      <div className="provider-controls">
        <Button
          variant="secondary"
          size="XL"
          isDisabled={!model}
          onPress={() => {
            onPending(true)
            setModels(workingModels())
            setModel("")
            setName("")
          }}
        >
          <Add /> {t("model.update")}
        </Button>
        <Button
          variant="accent"
          size="XL"
          isDisabled={!id}
          onPress={() =>
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
        <Button variant="secondary" size="XL" onPress={onDiscard}>
          {t("provider.discardEndpoint")}
        </Button>
      </div>
      <Prose size="2" color="gray" className="section-copy">
        {t("provider.stageHelp")}
      </Prose>
    </Panel>
  )
}
