export class Semaphore {
  #active = 0
  readonly #waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.#active >= this.limit) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve))
    } else {
      this.#active += 1
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.#waiters.shift()
      if (next) next()
      else this.#active -= 1
    }
  }
}
