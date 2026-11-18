import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { createPiFixture } from "./pi-fixture.js"

const FIXTURE_ORIGIN = "https://issue-provider.example.test/v1"

/** Give the issue worker an HTTPS model descriptor. Only the injected test runtime can send to loopback. */
export function issueFixtureRuntime({
  modelRuntime,
  endpoint,
}: Pick<Awaited<ReturnType<typeof createPiFixture>>, "modelRuntime" | "endpoint">): ModelRuntime {
  return new Proxy(modelRuntime, {
    get(target, property) {
      if (property === "getModel" || property === "getPhysicalModel")
        return (provider: string, id: string) => {
          const model = target[property](provider, id)
          return model?.baseUrl === endpoint ? { ...model, baseUrl: FIXTURE_ORIGIN } : model
        }
      if (property === "streamSimple")
        return (...[model, messages, options]: Parameters<ModelRuntime["streamSimple"]>) => {
          if (model.baseUrl !== FIXTURE_ORIGIN) throw new Error("Unexpected fixture model")
          return target.streamSimple({ ...model, baseUrl: endpoint }, messages, options)
        }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
