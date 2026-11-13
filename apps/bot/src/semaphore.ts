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
    return this.#release()
  }

  /** Account for already-admitted durable work before accepting new work. */
  reserve(): () => void {
    this.#active += 1
    return this.#release()
  }

  #release(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.#active -= 1
      if (this.#active < this.limit) {
        const next = this.#waiters.shift()
        if (next) {
          this.#active += 1
          next()
        }
      }
    }
  }
}
