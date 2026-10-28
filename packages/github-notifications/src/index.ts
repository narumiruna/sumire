export type { GithubMentionClientOptions } from "./api.js"
export {
  createGithubMentionClient,
  type GithubAccount,
  type GithubMention,
  type MentionPage,
  type MentionQuery,
} from "./client.js"
export { allowsMentionAuthor, mentionsAccount } from "./config.js"
