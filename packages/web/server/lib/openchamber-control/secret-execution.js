import { spawn } from "node:child_process";
import { isRecord, isString } from "../shared/guards.js";
const OUTPUT_LIMIT = 1024 * 1024;
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "LOGNAME",
  "DISPLAY",
  "XAUTHORITY",
  "SSH_AUTH_SOCK",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "WAYLAND_DISPLAY"
];
// Also embedded in the generated plugin so permission checks use the exact
// command the server will run. Keep validation self-contained.
export function normalizeSecretExecution(input, baseDirectory, { isAbsolute, resolve, isString, isRecord }) {
  const validKey = (key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && key !== "__proto__";
  const validString = (value) => isString(value) && !value.includes("\0");
  if (!validString(input.program) || !isAbsolute(input.program))
    throw new Error("Invalid program.");
  const args = input.args === undefined ? [] : input.args;
  if (!Array.isArray(args) || !Array.from(args).every(validString))
    throw new Error("Invalid arguments.");
  if (!Array.isArray(input.inputs) || input.inputs.length < 1 || input.inputs.length > 8) {
    throw new Error("Invalid private inputs.");
  }
  const keys = new Set();
  const inputs = Array.from(input.inputs, (item) => {
    if (!item || !isString(item.env) || !validKey(item.env) || keys.has(item.env)) {
      throw new Error("Invalid private environment key.");
    }
    if (!isString(item.label) || !item.label.trim() || item.label.length > 120) {
      throw new Error("Invalid private input label.");
    }
    keys.add(item.env);
    return { env: item.env, label: item.label };
  });
  const publicEnv = input.env === undefined ? {} : input.env;
  if (!isRecord(publicEnv))
    throw new Error("Invalid public environment.");
  const entries = Object.entries(publicEnv);
  if (entries.some(([key, value]) => !validKey(key) || keys.has(key) || !validString(value))) {
    throw new Error("Invalid public environment.");
  }
  const workdir = input.workdir === undefined ? baseDirectory : input.workdir;
  if (!validString(workdir))
    throw new Error("Invalid working directory.");
  const timeoutMs = input.timeoutMs === undefined ? 120000 : input.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw new Error("Invalid timeout.");
  return {
    program: input.program,
    args: [...args],
    inputs,
    env: Object.fromEntries(entries),
    workdir: resolve(baseDirectory, workdir),
    timeoutMs
  };
}
export function validateSecretValues(request, secrets) {
  if (!isRecord(secrets)) {
    throw new Error("Invalid secret inputs.");
  }
  const entries = Object.entries(secrets);
  const keys = new Set(request.inputs.map((item) => item.env));
  if (entries.length !== keys.size || entries.some(([key, value]) =>
    !keys.has(key) || !isString(value) || !value || value.includes("\0") || value.length > 16_000,
  )) throw new Error("All private inputs must be supplied together, without empty values or NUL characters, at most 16000 characters each.");
  return Object.fromEntries(entries);
}

export async function runSecret(request, secrets, signal) {
  const entries = Object.entries(validateSecretValues(request, secrets));
  if (signal.aborted)
    return { status: "cancelled", exitCode: null, stdout: "", stderr: "" };
  const pattern = new RegExp(entries.map(([, value]) => value).sort((a, b) => b.length - a.length).map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const redact = (text) => text.replace(pattern, "[REDACTED]");
  const inherited = INHERITED_ENV.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]);
  const env = Object.fromEntries([["PATH", "/usr/bin:/bin"], ...inherited, ...Object.entries(request.env), ...entries]);
  Object.setPrototypeOf(env, null);
  return new Promise((resolveResult) => {
    let status;
    let stdout = [];
    let stderr = [];
    let bytes = 0;
    let timer;
    let settled = false;
    const finish = (exitCode, spawnFailed = false) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      const result = {
        status: status ?? (spawnFailed || exitCode !== 0 ? "failed" : "completed"),
        exitCode,
        stdout: status === "output_limit" ? "" : redact(Buffer.concat(stdout).toString("utf8")),
        stderr: status === "output_limit" ? "Process output limit exceeded; output discarded." : spawnFailed ? "Process could not be started." : redact(Buffer.concat(stderr).toString("utf8"))
      };
      stdout = [];
      stderr = [];
      resolveResult(result);
    };
    let child;
    try {
      child = spawn(request.program, request.args, {
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: request.workdir,
        env
      });
    } catch {
      finish(null, true);
      return;
    }
    function killGroup() {
      if (child.pid === undefined)
        return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group may already have exited.
      }
    }
    function stop(reason) {
      status ??= reason;
      killGroup();
    }
    function cancel() {
      stop("cancelled");
    }
    function collect(target, chunk) {
      if (status === "output_limit")
        return;
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) {
        // Discard partial secret prefixes as well, even after cancellation.
        stdout = [];
        stderr = [];
        status = "output_limit";
        killGroup();
        return;
      }
      (target === "stdout" ? stdout : stderr).push(chunk);
    }
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.once("error", () => {
      killGroup();
      finish(null, true);
    });
    // Reap descendants that inherited pipes even after a normal leader exit.
    child.once("exit", killGroup);
    child.once("close", (code) => finish(code));
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => stop("timeout"), request.timeoutMs);
    if (signal.aborted)
      cancel();
  });
}
