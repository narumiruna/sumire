export class IssueError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
