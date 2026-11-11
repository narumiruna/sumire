import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const loggingUrl = new URL("../src/logging.ts", import.meta.url).href
const root = fileURLToPath(new URL("../../../", import.meta.url))
const fixture = `
  import * as logfire from '@pydantic/logfire-node';
  import { GrammyError } from 'grammy';
  import { createLogger } from ${JSON.stringify(loggingUrl)};
  const records = [];
  let closed = 0;
  const client = {
    ...logfire,
    configure(options) {
      logfire.configure({
        ...options, sendToLogfire: false, metrics: false, variables: false, apiKey: '',
        minLevel: null, sampling: {head: 1}, advanced: {pendingSpans: false},
        additionalSpanProcessors: [{
          onStart() {},
          onEnd(span) { records.push({name: span.name, attributes: span.attributes, status: span.status, events: span.events}); },
          async shutdown() {}, async forceFlush() {},
        }],
      });
    },
    async shutdown(options) { closed++; await logfire.shutdown(options); },
  };
  const failure = () => new GrammyError(
    'https://api.telegram.org/bot123456:private-process-token/sendMessage?signature=private-process-query',
    {ok: false, error_code: 400, description: 'private-process-description'},
    'sendMessage', {text: 'private-process-body', document: 'private-process-file'},
  );
  const output = (result) => console.log(JSON.stringify(result));
`

function run(script: string) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", fixture + script],
    {
      cwd: root,
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 20_000,
    },
  )
  if (result.error) throw result.error
  return { ...result, data: JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null") }
}

describe("isolated SDK process lifecycle", () => {
  it("replaces only SDK-owned hooks and releases application-owned hooks on shutdown/reconfiguration", () => {
    const result = run(`
      const events = ['SIGTERM', 'beforeExit', 'uncaughtExceptionMonitor', 'unhandledRejection'];
      const handlers = events.map(() => () => {});
      events.forEach((event, index) => process.on(event, handlers[index]));
      const initialListeners = events.map(event => process.listeners(event));
      const initial = initialListeners.map(listeners => listeners.length);
      const first = createLogger(false, 'offline-token', client);
      const afterFirst = events.map(event => process.listeners(event).length);
      const ownedFirst = events.map((event, index) => process.listeners(event).filter(listener => !initialListeners[index].includes(listener)));
      const second = createLogger(false, 'offline-token', client);
      const oldRemoved = events.every((event, index) => ownedFirst[index].every(listener => !process.listeners(event).includes(listener)));
      const afterSecond = events.map(event => process.listeners(event).length);
      await first.shutdown();
      const closedAfterOldShutdown = closed;
      second.info('Second logger active', {'event.name': 'app.second.active', 'pi.session_id': 'session_id-live'});
      await second.shutdown();
      const afterShutdown = events.map(event => process.listeners(event).length);
      const preserved = events.every((event, index) => process.listeners(event).includes(handlers[index]));
      events.forEach((event, index) => process.removeListener(event, handlers[index]));
      output({initial, afterFirst, afterSecond, afterShutdown, oldRemoved, preserved, closedAfterOldShutdown, closed, records});
    `)
    expect(result.status).toBe(0)
    expect(result.data).toMatchObject({
      afterFirst: result.data.initial.map(
        (count: number, index: number) => count + (index >= 2 ? 1 : 0),
      ),
      afterSecond: result.data.afterFirst,
      afterShutdown: result.data.initial,
      oldRemoved: true,
      preserved: true,
      closedAfterOldShutdown: 0,
      closed: 1,
    })
    expect(JSON.stringify(result.data.records)).toContain("session_id-live")
  })

  it("does not let SDK SIGTERM close telemetry before application drain", () => {
    const result = run(`
      let logger;
      const baseline = process.listenerCount('SIGTERM');
      const drained = new Promise(resolve => process.once('SIGTERM', async () => {
        const closedBeforeDrain = closed;
        await new Promise(done => setTimeout(done, 10));
        logger.info('Resources drained', {'event.name': 'application.stopped'});
        await logger.shutdown();
        resolve(closedBeforeDrain);
      }));
      logger = createLogger(false, 'offline-token', client);
      process.kill(process.pid, 'SIGTERM');
      const closedBeforeDrain = await drained;
      output({closedBeforeDrain, closed, records, baseline, listeners: process.listenerCount('SIGTERM')});
    `)
    expect(result.status).toBe(0)
    expect(result.data).toMatchObject({
      closedBeforeDrain: 0,
      closed: 1,
      listeners: result.data.baseline,
    })
    expect(result.data.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({ "event.name": "application.stopped" }),
        }),
      ]),
    )
  })

  it("reports actual unhandled rejections safely and keeps SDK observe-and-continue behavior explicit", () => {
    const result = run(`
      const logger = createLogger(false, 'offline-token', client);
      Promise.reject(failure());
      await new Promise(resolve => setTimeout(resolve, 20));
      logger.info('Application continued', {'event.name': 'app.continued'});
      await logger.shutdown();
      output({records, closed, listeners: process.listenerCount('unhandledRejection'), exitCode: process.exitCode ?? 0});
    `)
    expect(result.status).toBe(0)
    expect(result.data).toMatchObject({ closed: 1, listeners: 0, exitCode: 0 })
    const record = result.data.records.find(
      (value: { attributes: { "event.name": string } }) =>
        value.attributes["event.name"] === "process.unhandled_rejection",
    )
    expect(record).toMatchObject({
      attributes: {
        "error.type": "GrammyError",
        "http.response.status_code": 400,
        "http.request.method": "sendMessage",
        "logfire.level_num": 17,
      },
    })
    expect(JSON.stringify(result.data) + result.stderr).not.toContain("private-process-")
  })

  it("reports real uncaught exceptions safely without suppressing Node's fatal behavior", () => {
    const result = run(`
      const logger = createLogger(false, 'offline-token', client);
      process.on('uncaughtExceptionMonitor', () => output({records, closed}));
      setImmediate(() => { throw failure(); });
    `)
    expect(result.status).toBe(1)
    const record = result.data.records.find(
      (value: { attributes: { "event.name": string } }) =>
        value.attributes["event.name"] === "process.uncaught_exception",
    )
    expect(record).toMatchObject({
      attributes: {
        "error.type": "GrammyError",
        "http.response.status_code": 400,
        "logfire.level_num": 17,
      },
      events: [],
    })
    expect(JSON.stringify(result.data)).not.toContain("private-process-")
    // Node's native fatal stack on stderr is not application telemetry. Keeping
    // native crash behavior does not promise to redact that runtime-owned text.
  })
})
