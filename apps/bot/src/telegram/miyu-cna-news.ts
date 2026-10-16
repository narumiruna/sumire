import { MiyuCnaNews } from "@narumitw/sumire-pi-miyu-cna-news"
import type { Api } from "grammy"
import type { Message, User } from "grammy/types"
import type { AdminStore } from "../admin/store.js"
import type { Logger } from "../logging.js"

// grammY declares abort-controller signals, but accepts native signals at runtime.
const telegramSignal = (signal: AbortSignal) =>
  signal as unknown as NonNullable<Parameters<Api["sendMessage"]>[3]>
const toolName = "miyu_cna_news"
const isMiyu = (user: Pick<User, "id" | "is_bot" | "username">) =>
  user.is_bot && user.username?.toLowerCase() === "miyuyo_bot"

/** Telegram identity discovery is separate from fresh membership verification. */
export class TelegramMiyuNews {
  readonly #client: MiyuCnaNews
  #userId?: number

  constructor(
    private readonly api: Pick<
      Api,
      "getChat" | "getChatMember" | "getChatAdministrators" | "sendMessage"
    >,
    private readonly control: Pick<AdminStore, "allowsTool">,
    private readonly logger: Logger,
  ) {
    this.#client = new MiyuCnaNews({
      hasMiyuyoBot: (chatId, signal) => this.hasMiyuyoBot(chatId, signal),
      sendMessage: (chatId, text, signal) => {
        if (!this.control.allowsTool(chatId, toolName)) throw new Error("Tool is not allowed")
        return this.api.sendMessage(chatId, text, {}, telegramSignal(signal))
      },
    })
  }

  /** Use only authentic Telegram updates, after chat authorization. */
  observe(message: Message) {
    for (const user of [
      message.from,
      ...(message.new_chat_members ?? []),
      message.left_chat_member,
    ]) {
      if (user && isMiyu(user)) this.#userId = user.id
    }
  }

  async handleMessage(message: Message): Promise<boolean> {
    if (!this.control.allowsTool(message.chat.id, toolName)) return false
    return this.#client.handleMessage(message)
  }

  async createTool(chatId: number): ReturnType<MiyuCnaNews["createTool"]> {
    if (chatId >= 0 || !this.control.allowsTool(chatId, toolName)) return undefined
    try {
      const signal = AbortSignal.timeout(10_000)
      const chat = await this.api.getChat(chatId, telegramSignal(signal))
      return await this.#client.createTool(chat, signal)
    } catch {
      this.logger.warn(`Miyu tool unavailable: could not verify membership for chat_id=${chatId}`)
      return undefined
    }
  }

  private async hasMiyuyoBot(chatId: number, parentSignal?: AbortSignal): Promise<boolean> {
    if (!this.control.allowsTool(chatId, toolName)) return false
    const deadline = AbortSignal.timeout(10_000)
    const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline
    if (this.#userId === undefined) {
      const admins = await this.api.getChatAdministrators(
        chatId,
        { return_bots: true },
        telegramSignal(signal),
      )
      const miyu = admins.find(({ user }) => isMiyu(user))
      if (!miyu) return false
      this.#userId = miyu.user.id
    }
    const member = await this.api.getChatMember(chatId, this.#userId, telegramSignal(signal))
    return (
      this.control.allowsTool(chatId, toolName) &&
      isMiyu(member.user) &&
      // Plain bot mentions require the receiving bot to be a group administrator.
      (member.status === "creator" || member.status === "administrator")
    )
  }
}
