import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import path from "node:path"

const activeHomes = new Set<string>()

/** Chat storage has one process owner; sweep only reserved homes, never persisted results. */
export class McpProcessHomes {
  #prepared?: Promise<void>
  constructor(private readonly directory: string) {}

  async create(): Promise<string> {
    this.#prepared ??= this.prepare()
    await this.#prepared
    const home = await mkdtemp(path.join(this.directory, "process-"))
    activeHomes.add(home)
    return home
  }

  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      const home = path.join(this.directory, entry.name)
      if (entry.isDirectory() && entry.name.startsWith("process-") && !activeHomes.has(home))
        await rm(home, { recursive: true, force: true })
    }
  }

  async remove(home: string): Promise<void> {
    await rm(home, { recursive: true, force: true })
    activeHomes.delete(home)
  }
}
