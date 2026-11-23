import { style } from "@react-spectrum/s2/style" with { type: "macro" }

const palette = style({
  "--app-page": { type: "backgroundColor", value: "layer-1" },
  "--app-panel": { type: "backgroundColor", value: "layer-2" },
  "--app-neutral-quiet": { type: "backgroundColor", value: "gray-75" },
  "--app-neutral-soft": { type: "backgroundColor", value: "gray-100" },
  "--app-neutral-hover": { type: "backgroundColor", value: "gray-200" },
  "--app-line": { type: "borderColor", value: "gray-300" },
  "--app-border": { type: "borderColor", value: "gray-500" },
  "--app-border-emphasis": { type: "borderColor", value: "gray-600" },
  "--app-control-border": { type: "borderColor", value: "gray-700" },
  "--app-text": { type: "color", value: "body" },
  "--app-muted": { type: "color", value: "neutral-subdued" },
  "--app-accent": { type: "color", value: "accent-1000" },
  "--app-accent-strong": { type: "color", value: "accent-1300" },
  "--app-accent-soft": { type: "backgroundColor", value: "accent-subtle" },
  "--app-accent-line": { type: "borderColor", value: "accent-500" },
  "--app-focus": { type: "outlineColor", value: "focus-ring" },
  "--app-danger": { type: "color", value: "negative-1000" },
  "--app-warning": { type: "color", value: "notice-1000" },
  "--app-warning-soft": { type: "backgroundColor", value: "notice-subtle" },
  "--app-warning-line": { type: "borderColor", value: "notice-700" },
  "--app-violet-soft": { type: "backgroundColor", value: "purple-200" },
  "--app-violet": { type: "color", value: "purple-1100" },
})

export function applyAdminTheme() {
  document.documentElement.classList.add(...palette.trim().split(/\s+/))
  document.documentElement.dataset.colorScheme = "light"
}
