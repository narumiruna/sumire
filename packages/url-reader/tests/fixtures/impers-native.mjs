// Replace only the native dependency; execute the production host and protocol unchanged.
import { registerHooks } from "node:module"

const source = `
export class Session {
  async get(url, options) {
    options.headerCallback(Buffer.from('HTTP/1.1 200 OK\\r\\n'))
    options.contentCallback(Buffer.from([0, 255, 128]))
    if (options.signal.aborted) throw new Error('native callback aborted')
    return {
      status: 200, statusText: 'OK', url, headers: [], elapsed: 0,
      primaryIp: null, primaryPort: 0, localIp: null, localPort: 0,
      redirectCount: 0, redirectUrl: null, httpVersion: 1,
      async close() {
        await new Promise(resolve => setTimeout(resolve, 100))
        if (url.endsWith('/close-fails')) throw new Error('private native cleanup diagnostic')
      },
    }
  }
  async close() {}
}
`
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "impers") {
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
