import { spawn } from "child_process";

export async function ensureContainerRunning(
  containerName: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const inspect = spawn("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      containerName,
    ]);
    let output = "";
    inspect.stdout.on("data", (chunk) => (output += chunk.toString()));
    inspect.on("close", (code) => {
      if (code === 0 && output.trim() === "true") resolve();
      else reject(new Error(`Container ${containerName} not running`));
    });
  });
}
