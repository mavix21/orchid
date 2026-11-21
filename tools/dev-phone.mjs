import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const devPort = 3000;
const servePort = 8443;
const devTarget = `http://localhost:${devPort}`;
const repoRoot = new URL("../", import.meta.url).pathname;
const pidFile = join(tmpdir(), "orchid-dev-phone.pid");
const readyTimeoutMs = 120_000;
const shutDownGraceMs = 10_000;
const setupHint = 'One-time setup: see "Test from your phone" in README.md.';

const fail = (message) => {
  process.stderr.write(`dev:phone: ${message}\n`);
  process.exit(1);
};

const tailscale = (...args) => {
  const result = spawnSync("tailscale", args, { encoding: "utf8" });

  if (result.error?.code === "ENOENT")
    fail(`the tailscale CLI is not installed. ${setupHint}`);

  return result;
};

const parseJson = (text, source) => {
  try {
    return JSON.parse(text);
  } catch {
    return fail(`could not read the output of ${source}.`);
  }
};

const readTailnetHost = () => {
  const result = tailscale("status", "--json");

  if (!result.stdout)
    fail(`tailscale is not running. Start the Tailscale app. ${setupHint}`);

  const status = parseJson(result.stdout, "tailscale status --json");

  if (status.BackendState !== "Running")
    fail(
      `Tailscale is ${status.BackendState}. Open the Tailscale app and sign in. ${setupHint}`,
    );

  if (!status.CertDomains?.length)
    fail(`HTTPS certificates are not enabled for this tailnet. ${setupHint}`);

  return status.Self.DNSName.replace(/\.$/, "");
};

const readServeStatus = () => {
  const result = tailscale("serve", "status", "--json");

  return result.status === 0
    ? parseJson(result.stdout, "tailscale serve status --json")
    : {};
};

const servedHostPort = (host) => `${host}:${servePort}`;

const readRootHandler = (host) =>
  readServeStatus().Web?.[servedHostPort(host)]?.Handlers?.["/"];

const isFunnelExposingDevServer = (host) => {
  const status = readServeStatus();

  return Object.entries(status.AllowFunnel ?? {}).some(
    ([hostPort, open]) =>
      open &&
      (hostPort === servedHostPort(host) ||
        Object.values(status.Web?.[hostPort]?.Handlers ?? {}).some(
          (handler) => handler.Proxy === devTarget,
        )),
  );
};

const turnServeOff = (host) => {
  if (readRootHandler(host)?.Proxy !== devTarget) return;

  tailscale("serve", `--https=${servePort}`, "--set-path=/", "off");
};

const publicUrl = (host) => `https://${host}:${servePort}`;

const processCommand = (pid) =>
  spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  }).stdout;

const isProcessNamed = (pid, name) =>
  Number.isInteger(pid) && processCommand(pid).includes(name);

const readState = () => {
  try {
    return JSON.parse(readFileSync(pidFile, "utf8"));
  } catch {
    return undefined;
  }
};

const readRunningLauncher = () => {
  const state = readState();

  return state && isProcessNamed(state.launcher, "dev-phone.mjs")
    ? state.launcher
    : undefined;
};

const reapStale = () => {
  const state = readState();

  if (!state) return;

  if (isProcessNamed(state.dev, "run dev")) {
    try {
      process.kill(-state.dev, "SIGTERM");
    } catch {
      process.kill(state.dev, "SIGTERM");
    }
  }

  rmSync(pidFile, { force: true });
};

const isPortBusy = () =>
  spawnSync("lsof", ["-nP", `-iTCP:${devPort}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  }).stdout.trim() !== "";

const assertNotPublic = (host) => {
  if (isFunnelExposingDevServer(host))
    fail(
      `Tailscale Funnel exposes the dev server publicly. Turn it off with \`tailscale funnel --https=${servePort} off\` (or the port it uses) and retry.`,
    );
};

const serveOnTailnet = (host) => {
  assertNotPublic(host);

  const root = readRootHandler(host);

  if (root !== undefined && root.Proxy !== devTarget)
    fail(
      `port ${servePort} on this machine already serves something else at /. Free it with \`tailscale serve --https=${servePort} off\` and retry.`,
    );

  const result = tailscale(
    "serve",
    "--bg",
    "--yes",
    `--https=${servePort}`,
    "--set-path=/",
    devTarget,
  );

  if (result.status !== 0)
    fail(`tailscale serve failed.\n${result.stderr}${result.stdout}`);

  if (isFunnelExposingDevServer(host)) {
    turnServeOff(host);
    fail("Tailscale Funnel is enabled for this port; refusing to continue.");
  }
};

const waitUntilReady = async (isAlive) => {
  const deadline = Date.now() + readyTimeoutMs;

  while (Date.now() < deadline && isAlive()) {
    const ready = await fetch(devTarget).then(
      () => true,
      () => false,
    );

    if (ready) return true;

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
};

const start = async () => {
  const host = readTailnetHost();
  const runningLauncher = readRunningLauncher();

  if (runningLauncher !== undefined) {
    serveOnTailnet(host);
    process.stdout.write(
      `dev:phone is already running (pid ${runningLauncher}).\n`,
    );
    process.stdout.write(`${publicUrl(host)}\n`);

    return;
  }

  reapStale();
  assertNotPublic(host);

  try {
    writeFileSync(pidFile, JSON.stringify({ launcher: process.pid }), {
      flag: "wx",
    });
  } catch {
    fail("another dev:phone is starting. Retry in a moment.");
  }

  if (isPortBusy()) {
    rmSync(pidFile, { force: true });
    fail(
      `port ${devPort} is in use. Stop the process using it (a plain \`bun run dev\` included) and retry.`,
    );
  }

  const origin = publicUrl(host);

  const dev = spawn("bun", ["run", "dev", "--ui=stream"], {
    cwd: repoRoot,
    detached: true,
    stdio: "inherit",
    env: { ...process.env, ORCHID_PHONE_ORIGIN: origin },
  });

  let devExited = false;
  let stopping = false;

  writeFileSync(
    pidFile,
    JSON.stringify({ launcher: process.pid, dev: dev.pid }),
  );

  const signalDev = (signal) => {
    if (devExited) return;

    try {
      process.kill(-dev.pid, signal);
    } catch {
      dev.kill(signal);
    }
  };

  const shutDown = () => {
    if (stopping) return;

    stopping = true;
    signalDev("SIGTERM");
    setTimeout(() => {
      signalDev("SIGKILL");
      process.exit(0);
    }, shutDownGraceMs).unref();
  };

  process.on("exit", () => {
    signalDev("SIGKILL");
    turnServeOff(host);
    rmSync(pidFile, { force: true });
  });

  dev.on("exit", (code) => {
    devExited = true;
    process.exit(stopping ? 0 : (code ?? 1));
  });

  process.on("SIGINT", shutDown);
  process.on("SIGTERM", shutDown);
  process.on("SIGHUP", shutDown);

  if (!(await waitUntilReady(() => !devExited)))
    fail("the dev server did not become ready.");

  serveOnTailnet(host);
  process.stdout.write(`${origin}\n`);
};

const stop = () => {
  const runningLauncher = readRunningLauncher();

  if (runningLauncher !== undefined) {
    process.kill(runningLauncher, "SIGTERM");
    process.stdout.write("dev:phone is stopping.\n");

    return;
  }

  reapStale();
  turnServeOff(readTailnetHost());
  process.stdout.write("dev:phone is not running.\n");
};

const commands = { start, stop };
const command = commands[process.argv[2] ?? "start"];

if (!command) fail("usage: bun tools/dev-phone.mjs [start|stop]");

await command();
