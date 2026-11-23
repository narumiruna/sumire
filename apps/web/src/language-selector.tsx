import GlobeGrid from "@react-spectrum/s2/icons/GlobeGrid"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { type Locale, localeNames, locales, setLocale, t, useLocale } from "./i18n.js"

const languageTokens = style({
  font: "ui",
  "--language-surface": { type: "backgroundColor", value: "layer-2" },
  "--language-hover": { type: "backgroundColor", value: "gray-200" },
  "--language-border": { type: "borderColor", value: "gray-500" },
  "--language-text": { type: "color", value: "neutral" },
  "--language-focus": { type: "outlineColor", value: "focus-ring" },
  "--language-radius": { type: "borderRadius", value: "default" },
})

export function LanguageSelector() {
  const locale = useLocale()
  return (
    <label className={`language-selector spectrum-language ${languageTokens}`}>
      <GlobeGrid UNSAFE_className="language-selector-icon" />
      <span>{t("app.language")}</span>
      <select
        aria-label={t("app.language")}
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        {locales.map((value) => (
          <option key={value} value={value} lang={value}>
            {localeNames[value]}
          </option>
        ))}
      </select>
    </label>
  )
}
