import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CONTAINER_NAME = "talorys-computer-sandbox";
export const IMAGE_NAME = "talorys-computer:latest";
export const VNC_PORT = 28790;
export const CDP_PORT = 28791;

export interface ContainerInfo {
  running: boolean;
  id?: string;
  name: string;
  vncPort: number;
  cdpPort: number;
}

/** Check if the sandbox container is currently running */
export async function isContainerRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "--filter",
      `name=${CONTAINER_NAME}`,
      "--filter",
      "status=running",
      "--format",
      "{{.ID}}",
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Stop and remove the sandbox container if running */
export async function stopContainer(): Promise<void> {
  try {
    await execFileAsync("docker", ["rm", "-f", CONTAINER_NAME]);
  } catch {
    // Ignore error if not running
  }
}

/** Start the sandbox container and wait until VNC and CDP are ready */
export async function startContainer(): Promise<ContainerInfo> {
  const running = await isContainerRunning();
  if (running) {
    return {
      running: true,
      name: CONTAINER_NAME,
      vncPort: VNC_PORT,
      cdpPort: CDP_PORT,
    };
  }

  // Ensure any existing dead container is removed
  await stopContainer();

  const args = [
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "--rm",
    "--security-opt",
    "no-new-privileges",
    "--shm-size",
    "512m",
    "-p",
    `127.0.0.1:${VNC_PORT}:8444`,
    "-p",
    `127.0.0.1:${CDP_PORT}:9222`,
    IMAGE_NAME,
  ];

  const { stdout } = await execFileAsync("docker", args);
  const id = stdout.trim();

  // Wait for VNC and CDP to become responsive (up to 20 seconds)
  const maxAttempts = 40;
  let ready = false;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const cdpRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (cdpRes.ok) {
        ready = true;
        break;
      }
    } catch {
      // Retry
    }
  }

  if (!ready) {
    await stopContainer();
    throw new Error("Failed to initialize sandbox desktop: CDP port did not respond in time.");
  }

  return {
    running: true,
    id,
    name: CONTAINER_NAME,
    vncPort: VNC_PORT,
    cdpPort: CDP_PORT,
  };
}

/** Execute xdotool or other commands inside the sandbox container */
export async function execInContainer(cmd: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("docker", ["exec", "-u", "computer", CONTAINER_NAME, ...cmd]);
}
