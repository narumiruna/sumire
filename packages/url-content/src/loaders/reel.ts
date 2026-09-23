import type { Loader } from "../core/loader.js"
import type { ResourceProvider } from "../core/resources.js"
import { parseReelTarget } from "../sources/applicability.js"
import { HttpLoader } from "./generic.js"
import { YtdlpLoader } from "./ytdlp.js"

export class ReelLoader implements Loader {
  private readonly audio: Loader
  private readonly html: Loader

  constructor(
    options: { resources?: ResourceProvider; audioLoader?: Loader; htmlLoader?: Loader } = {},
  ) {
    this.audio = options.audioLoader ?? new YtdlpLoader()
    this.html = options.htmlLoader ?? new HttpLoader({ resources: options.resources })
  }

  async load(url: string, signal?: AbortSignal): Promise<string> {
    parseReelTarget(url)
    const shortcode = /^\/reel\/([A-Za-z0-9_-]+)\/?$/u.exec(new URL(url).pathname)?.[1]
    if (!shortcode) throw new Error("Invalid Instagram Reel path")
    // Keep tracking parameters and unexpected paths out of the audio downloader.
    const audio = await this.audio.load(`https://www.instagram.com/reel/${shortcode}/`, signal)
    const html = await this.html.load(url, signal)
    return `${audio}\n\n${html}`
  }
}
