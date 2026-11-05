import { type Locale, localeNames, locales, setLocale, t, useLocale } from "./i18n.js"

export function LanguageSelector() {
  const locale = useLocale()
  return (
    <label className="language-selector">
      <span>{t("app.language")}</span>
      <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
        {locales.map((value) => (
          <option key={value} value={value} lang={value}>
            {localeNames[value]}
          </option>
        ))}
      </select>
    </label>
  )
}
