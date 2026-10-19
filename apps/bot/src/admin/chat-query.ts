import { z } from "zod"
import { AdminError } from "./store.js"

const chatId = z
  .string()
  .regex(/^-?[1-9]\d*$/)
  .transform(Number)
  .pipe(
    z
      .number()
      .int()
      .safe()
      .refine((id) => id !== 0),
  )
const schema = z
  .object({
    q: z
      .string()
      .max(128)
      .refine((value) =>
        [...value].every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
      )
      .transform((value) => value.trim())
      .optional(),
    id: chatId.optional(),
    offset: z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .transform(Number)
      .pipe(z.number().int().max(1000))
      .default(0),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.id !== undefined && (query.q !== undefined || query.offset !== 0))
      ctx.addIssue({
        code: "custom",
        message: "Exact lookup cannot be combined with directory filters",
      })
  })

export type ChatFilters = Omit<z.infer<typeof schema>, "offset">

/** Search only the bounded persisted directory, never Telegram or session storage. */
export function parseChatQuery(params: URLSearchParams) {
  const values: Record<string, string> = Object.create(null)
  for (const [key, value] of params) {
    if (Object.hasOwn(values, key)) throw new AdminError(400, "Duplicate chat filter")
    values[key] = value
  }
  const parsed = schema.safeParse(values)
  if (!parsed.success) throw new AdminError(400, "Invalid chat query")
  return parsed.data
}
