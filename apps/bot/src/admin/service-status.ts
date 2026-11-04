import type { IncomingMessage, ServerResponse } from "node:http"
import { statusProviderIds } from "@narumitw/sumire-policy"
import { z } from "zod"
import type { StatusNotificationWorker } from "../service-status/runtime.js"
import { AdminError } from "./store.js"

export type ServiceStatusAdmin = Pick<
  StatusNotificationWorker,
  "components" | "deliveries" | "test" | "wake"
>

const chatId = z
  .string()
  .regex(/^-?[1-9]\d*$/)
  .refine((value) => String(Number(value)) === value)
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value) && value !== 0)
const queryValues = (params: URLSearchParams) => {
  const values: Record<string, string> = Object.create(null)
  for (const [key, value] of params) {
    if (Object.hasOwn(values, key)) throw new AdminError(400, "Duplicate service status filter")
    values[key] = value
  }
  return values
}

/** Runs after the shared administrator session, Origin, and CSRF checks. */
export async function handleServiceStatus(
  service: ServiceStatusAdmin | undefined,
  request: {
    req: IncomingMessage
    res: ServerResponse
    url: URL
    method: string
    actor: string
    deadline: number
    shutdown: AbortSignal
    authorize(): void
    body(req: IncomingMessage, limit: number): Promise<unknown>
  },
): Promise<unknown> {
  if (!service) throw new AdminError(503, "Service status is unavailable")
  const { req, res, url, method } = request
  request.authorize()
  if (url.pathname === "/api/service-status/deliveries") {
    if (method !== "GET") throw new AdminError(405, "Method not allowed")
    const query = z
      .object({
        offset: z.coerce.number().int().min(0).max(10000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(100),
        chatId: chatId.optional(),
        provider: z.enum([...statusProviderIds, "test"]).optional(),
      })
      .strict()
      .parse(queryValues(url.searchParams))
    return service.deliveries(query)
  }
  const isTest = url.pathname === "/api/service-status/test"
  if (!isTest && url.pathname !== "/api/service-status/components")
    throw new AdminError(404, "Not found")
  if (method !== (isTest ? "POST" : "GET")) throw new AdminError(405, "Method not allowed")
  const remaining = request.deadline - Date.now()
  if (remaining <= 0) throw new AdminError(401, "Administrator session expired")
  const disconnected = new AbortController()
  const signal = AbortSignal.any([
    disconnected.signal,
    request.shutdown,
    AbortSignal.timeout(Math.min(isTest ? 5000 : 16000, remaining)),
  ])
  const abort = () => disconnected.abort()
  const close = () => {
    if (!res.writableEnded) abort()
  }
  req.once("aborted", abort)
  res.once("close", close)
  try {
    let result: unknown
    if (isTest) {
      z.object({}).strict().parse(queryValues(url.searchParams))
      const input = z
        .object({
          chatId: z
            .number()
            .int()
            .safe()
            .refine((value) => value !== 0),
          revision: z.number().int().positive().safe(),
          confirm: z.literal(true),
        })
        .strict()
        .parse(await request.body(req, 4096))
      request.authorize()
      result = await service.test(input, {
        actor: request.actor,
        signal,
        authorize: request.authorize,
      })
    } else {
      const query = z
        .object({ provider: z.enum(statusProviderIds) })
        .strict()
        .parse(queryValues(url.searchParams))
      result = await service.components(query.provider, signal)
    }
    request.authorize()
    signal.throwIfAborted()
    return result
  } catch (error) {
    request.authorize()
    // Ending a rejected request body can also abort the request stream. Keep its actual error.
    if (error instanceof AdminError || error instanceof z.ZodError) throw error
    if (request.shutdown.aborted) throw new AdminError(503, "Server is stopping")
    if (signal.aborted) throw new AdminError(408, "Service status request was cancelled or expired")
    throw error
  } finally {
    req.off("aborted", abort)
    res.off("close", close)
  }
}
