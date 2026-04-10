import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const frontendDir = path.join(rootDir, "docs", "Flow Frontend");

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function start(name, cmd, args, cwd) {
  const child = spawn(cmd, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  child.on("error", (error) => {
    console.error(`[dev:all] ${name} failed to start:`, error.message);
  });

  return child;
}

function isPortInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    const finish = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };

    socket.setTimeout(700);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", (error) => {
      const err = error;
      if (err && typeof err === "object" && "code" in err && err.code === "ECONNREFUSED") {
        finish(false);
        return;
      }
      finish(false);
    });

    socket.connect(port, host);
  });
}

console.log("[dev:all] Starting backend (pnpm dev) and frontend (npm run dev)...");
console.log(`[dev:all] Backend cwd: ${rootDir}`);
console.log(`[dev:all] Frontend cwd: ${frontendDir}`);

const backendAlreadyRunning = await isPortInUse(4000);
if (backendAlreadyRunning) {
  console.log("[dev:all] Port 4000 already in use; assuming backend is already running and skipping backend start.");
}

const backend = backendAlreadyRunning ? null : start("backend", pnpmCmd, ["dev"], rootDir);
const frontend = start("frontend", npmCmd, ["run", "dev"], frontendDir);

let shuttingDown = false;

function stopChild(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  stopChild(backend, "SIGTERM");
  stopChild(frontend, "SIGTERM");

  setTimeout(() => {
    stopChild(backend, "SIGKILL");
    stopChild(frontend, "SIGKILL");
  }, 1500).unref();

  process.exit(exitCode);
}

if (backend) {
  backend.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev:all] backend exited (${signal || code || 0}). Stopping frontend.`);
    shutdown(typeof code === "number" ? code : 1);
  });
}

frontend.on("exit", (code, signal) => {
  if (shuttingDown) return;
  console.error(`[dev:all] frontend exited (${signal || code || 0}). Stopping backend.`);
  shutdown(typeof code === "number" ? code : 1);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
