#!/usr/bin/env bun

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"

import {
  CdpClient,
  createPageTarget,
  evaluateValue,
  launchChrome,
  reservePort,
  resolveChrome,
  wait,
} from "./cdp.mjs"

const DEFAULT_TEXT = "zhongwenshurufaceshijuzi"
const HELP = `Usage: bun run bench:composer-input -- [options]

Options:
  --url <url>              OpenChamber mobile URL (default: http://127.0.0.1:9601/mobile.html)
  --rounds <count>         Measured rounds per input (default: 5)
  --text <pinyin>          Composition text (default: ${DEFAULT_TEXT})
  --cpu-throttle <rate>    Chrome CPU throttling rate (default: 6)
  --budget-ratio <ratio>   Maximum composer/native p95 idle ratio (default: 5)
  --output <directory>     Summary directory (default: artifacts/composer-input-<time>)
  --chrome <path>          Chrome/Chromium executable
  --headless               Run without a visible browser
  --help                   Show this help`

const parseArgs = (argv) => {
  const options = {
    url: "http://127.0.0.1:9601/mobile.html",
    rounds: 5,
    text: DEFAULT_TEXT,
    cpuThrottle: 6,
    budgetRatio: 5,
    output: null,
    chrome: null,
    headless: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") return { ...options, help: true }
    if (value === "--headless") options.headless = true
    else if (value === "--url") options.url = argv[++index]
    else if (value === "--rounds") options.rounds = Number(argv[++index])
    else if (value === "--text") options.text = argv[++index]
    else if (value === "--cpu-throttle") options.cpuThrottle = Number(argv[++index])
    else if (value === "--budget-ratio") options.budgetRatio = Number(argv[++index])
    else if (value === "--output") options.output = argv[++index]
    else if (value === "--chrome") options.chrome = argv[++index]
    else throw new Error(`Unknown option: ${value}`)
  }

  new URL(options.url)
  if (!Number.isInteger(options.rounds) || options.rounds <= 0) {
    throw new Error("--rounds must be a positive integer")
  }
  if (!options.text) throw new Error("--text must not be empty")
  if (!Number.isFinite(options.cpuThrottle) || options.cpuThrottle < 1) {
    throw new Error("--cpu-throttle must be at least 1")
  }
  if (!Number.isFinite(options.budgetRatio) || options.budgetRatio <= 0) {
    throw new Error("--budget-ratio must be positive")
  }
  return options
}

const percentile = (values, ratio) => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
}

const summarizeMetric = (samples, key) => {
  const values = samples.map((sample) => Number(sample[key] ?? 0))
  const total = values.reduce((sum, value) => sum + value, 0)
  return {
    mean: Number((total / values.length).toFixed(3)),
    p50: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
    max: Number(Math.max(...values).toFixed(3)),
  }
}

const summarizeSamples = (samples) => ({
  samples: samples.length,
  deliveryMs: summarizeMetric(samples, "deliveryMs"),
  idleTotalMs: summarizeMetric(samples, "idleTotalMs"),
  frameTotalMs: summarizeMetric(samples, "frameTotalMs"),
})

const withTimeout = (promise, timeoutMs, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)),
])

const waitForCondition = async (client, expression, label, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluateValue(client, expression)) return
    await wait(100)
  }
  const page = await evaluateValue(client, `({ url: location.href, body: document.body?.innerText?.slice(0, 500) ?? "" })`)
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(page)}`)
}

const unlockIfNeeded = async (client) => {
  const locked = await evaluateValue(client, `Boolean(document.querySelector("#openchamber-ui-password"))`)
  if (!locked) return

  const password = process.env.OPENCHAMBER_UI_PASSWORD || process.env.OPENCODE_UI_PASSWORD
  if (!password) {
    throw new Error("The benchmark URL is locked; set OPENCHAMBER_UI_PASSWORD or OPENCODE_UI_PASSWORD")
  }

  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector("#openchamber-ui-password");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(password)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.closest("form").requestSubmit();
    })()`,
  })
  await waitForCondition(client, `!document.querySelector("#openchamber-ui-password")`, "OpenChamber unlock")
}

const probeSource = String.raw`(() => {
  const matchesTarget = (target, eventTarget) => target === "native"
    ? eventTarget instanceof Node && document.querySelector("#oc-composer-native-benchmark")?.contains(eventTarget)
    : eventTarget instanceof Node && document.querySelector(".cm-content")?.contains(eventTarget);

  window.__composerInputBenchmark = {
    pending: null,
    events: [],
    next(target) {
      if (this.pending) throw new Error("A benchmark input is already pending");
      return new Promise((resolve, reject) => {
        const pending = {
          target,
          startedAt: performance.now(),
          inputAt: null,
          idleAt: null,
          frameAt: null,
        };
        this.pending = pending;

        const cleanup = () => {
          clearTimeout(timeout);
          document.removeEventListener("input", onInput, true);
          if (this.pending === pending) this.pending = null;
        };
        const finish = () => {
          if (pending.idleAt == null || pending.frameAt == null) return;
          cleanup();
          resolve({
            deliveryMs: pending.inputAt - pending.startedAt,
            idleTotalMs: pending.idleAt - pending.startedAt,
            frameTotalMs: pending.frameAt - pending.startedAt,
          });
        };
        const onInput = (event) => {
          this.events.push({
            tag: event.target?.tagName ?? null,
            id: event.target?.id ?? null,
            inputType: event.inputType ?? null,
          });
          if (!matchesTarget(target, event.target)) return;
          pending.inputAt = performance.now();
          document.removeEventListener("input", onInput, true);

          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            pending.idleAt = performance.now();
            channel.port1.close();
            channel.port2.close();
            finish();
          };
          channel.port2.postMessage(null);

          requestAnimationFrame((timestamp) => {
            pending.frameAt = timestamp;
            finish();
          });
        };
        document.addEventListener("input", onInput, true);
        const timeout = setTimeout(() => {
          const active = document.activeElement;
          cleanup();
          reject(new Error("Input event did not arrive; active="
            + (active?.tagName ?? "none") + "#" + (active?.id ?? "")
            + "; events=" + JSON.stringify(this.events.slice(-5))));
        }, 5000);
      });
    },
  };
})()`

const installNativeControlSource = String.raw`(() => {
  const control = document.createElement("div");
  control.id = "oc-composer-native-benchmark";
  control.contentEditable = "true";
  control.setAttribute("aria-label", "Native input benchmark");
  control.style.cssText = "position:fixed;z-index:2147483647;left:8px;top:8px;width:360px;height:120px;font:16px sans-serif";
  document.body.appendChild(control);
  control.focus();
})()`

const openComposerSource = String.raw`(() => {
  document.querySelector("#oc-composer-native-benchmark")?.remove();
  const content = document.querySelector(".cm-content");
  if (content) {
    content.focus();
    return true;
  }
  const button = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes("Use @ / ! # for helpers")
  );
  button?.click();
  return false;
})()`

const runInput = async (client, target, value) => {
  const resultPromise = client.send("Runtime.evaluate", {
    expression: `window.__composerInputBenchmark.next(${JSON.stringify(target)})`,
    awaitPromise: true,
    returnByValue: true,
  })
  await evaluateValue(client, `document.execCommand("selectAll")`)
  const inserted = await evaluateValue(client, `document.execCommand("insertText", false, ${JSON.stringify(value)})`)
  if (!inserted) throw new Error(`${target} insertText command was rejected`)

  const result = await withTimeout(resultPromise, 7_000, `${target} input`)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? `${target} input failed`)
  return result.result?.value
}

const runStage = async ({ client, target, text, rounds, reset, startComposition, endComposition, readState }) => {
  const inputs = [...text].map((_, index) => text.slice(0, index + 1))
  const samples = []

  for (let round = -1; round < rounds; round += 1) {
    await reset()
    await startComposition()
    for (const value of inputs) {
      const sample = await runInput(client, target, value)
      if (round >= 0) samples.push(sample)
    }

    const state = await readState()
    if (state.value !== text || state.selected !== "") {
      throw new Error(`${target} correctness failure: ${JSON.stringify(state)}`)
    }
    await endComposition()
  }

  return samples
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }

  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
  const output = resolve(options.output ?? join("artifacts", `composer-input-${timestamp}`))
  const profileDir = await mkdtemp(join(tmpdir(), "openchamber-composer-input-"))
  const port = await reservePort()
  const chromeProcess = launchChrome({
    chrome: resolveChrome(options.chrome),
    profileDir,
    port,
    headless: options.headless,
  })
  let client

  try {
    const target = await createPageTarget(port)
    client = new CdpClient(target.webSocketDebuggerUrl)
    await client.connect()
    await Promise.all([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
      }),
      client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }),
      client.send("Emulation.setUserAgentOverride", {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
        platform: "iPhone",
        acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
      }),
      client.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `Object.defineProperty(navigator, "vendor", { get: () => "Apple Computer, Inc." });`,
      }),
    ])

    const loaded = client.once("Page.loadEventFired", 30_000)
    await client.send("Page.navigate", { url: options.url })
    await loaded
    await client.send("Page.bringToFront")
    await client.send("Emulation.setFocusEmulationEnabled", { enabled: true })
    await waitForCondition(client, `document.body?.innerText?.length > 0`, "initial page")
    await unlockIfNeeded(client)
    await waitForCondition(client, `document.body?.textContent?.includes("Use @ / ! # for helpers")`, "composer shell")
    await wait(2_000)
    await client.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle })
    await client.send("Runtime.evaluate", { expression: probeSource })

    const frameIntervals = await evaluateValue(client, String.raw`new Promise((resolve) => {
      const intervals = [];
      let previous = performance.now();
      const frame = (now) => {
        intervals.push(now - previous);
        previous = now;
        if (intervals.length >= 12) resolve(intervals);
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    })`)
    if (!Array.isArray(frameIntervals) || frameIntervals.length < 12 || Math.max(...frameIntervals) > 250) {
      throw new Error(`Renderer frame liveness check failed: ${JSON.stringify(frameIntervals)}`)
    }

    await client.send("Runtime.evaluate", { expression: installNativeControlSource })
    const nativeSamples = await runStage({
      client,
      target: "native",
      text: options.text,
      rounds: options.rounds,
      reset: () => client.send("Runtime.evaluate", {
        expression: `(() => {
          const control = document.querySelector("#oc-composer-native-benchmark");
          control.textContent = "";
          control.focus();
        })()`,
      }),
      startComposition: () => client.send("Runtime.evaluate", {
        expression: `document.querySelector("#oc-composer-native-benchmark").dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))`,
      }),
      endComposition: () => client.send("Runtime.evaluate", {
        expression: `document.querySelector("#oc-composer-native-benchmark").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))`,
      }),
      readState: () => evaluateValue(client, String.raw`(() => {
        const control = document.querySelector("#oc-composer-native-benchmark");
        return { value: control.innerText.replace(/\n$/, ""), selected: getSelection().toString() };
      })()`),
    })

    await client.send("Runtime.evaluate", { expression: openComposerSource })
    await waitForCondition(client, `Boolean(document.querySelector(".cm-content")?.cmTile?.view)`, "ComposerEditor")
    const composerSamples = await runStage({
      client,
      target: "composer",
      text: options.text,
      rounds: options.rounds,
      reset: async () => {
        await client.send("Runtime.evaluate", {
          expression: String.raw`(() => {
            const view = document.querySelector(".cm-content").cmTile.view;
            const length = view.state.doc.length;
            if (length) view.dispatch({ changes: { from: 0, to: length, insert: "" } });
            view.contentDOM.focus();
          })()`,
        })
        await wait(30)
      },
      startComposition: () => client.send("Runtime.evaluate", {
        expression: `document.querySelector(".cm-content").dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))`,
      }),
      endComposition: async () => {
        await client.send("Runtime.evaluate", {
          expression: `document.querySelector(".cm-content").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))`,
        })
        await wait(30)
      },
      readState: () => evaluateValue(client, String.raw`(() => {
        const view = document.querySelector(".cm-content").cmTile.view;
        return { value: view.state.doc.toString(), selected: getSelection().toString() };
      })()`),
    })

    const native = summarizeSamples(nativeSamples)
    const composer = summarizeSamples(composerSamples)
    const idleP95Ratio = composer.idleTotalMs.p95 / Math.max(native.idleTotalMs.p95, 0.001)
    const summary = {
      config: {
        url: options.url,
        rounds: options.rounds,
        charactersPerRound: options.text.length,
        text: options.text,
        scenario: "replace-compose",
        browserMode: "ios",
        cpuThrottle: options.cpuThrottle,
        budgetRatio: options.budgetRatio,
      },
      validity: {
        frameSamples: frameIntervals.length,
        frameP50Ms: Number(percentile(frameIntervals, 0.5).toFixed(3)),
        frameMaxMs: Number(Math.max(...frameIntervals).toFixed(3)),
        equalWorkload: native.samples === composer.samples,
      },
      native,
      composer,
      ratios: {
        idleP95: Number(idleP95Ratio.toFixed(3)),
        frameP95: Number((composer.frameTotalMs.p95 / Math.max(native.frameTotalMs.p95, 0.001)).toFixed(3)),
      },
      budgetPassed: idleP95Ratio <= options.budgetRatio,
    }

    await mkdir(output, { recursive: true })
    await writeFile(join(output, "composer-input-summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(JSON.stringify(summary, null, 2))
    console.log(`Summary: ${join(output, "composer-input-summary.json")}`)
    if (!summary.budgetPassed) process.exitCode = 1
  } finally {
    if (client) {
      await client.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {})
      client.close()
    }
    chromeProcess.kill("SIGTERM")
    await rm(profileDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
