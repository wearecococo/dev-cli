/**
 * Tiny prompt helper for interactive confirmations. Reads from stdin
 * one line at a time. Used by state-tracking apply / import.
 *
 * Two modes:
 *  - `promptYes(question)` — accepts `y` / `yes` (case-insensitive).
 *  - `promptStrictYes(question)` — requires the literal lowercase
 *    word `yes`. Used when a destructive op needs explicit consent.
 */

import { stdin, stdout } from "node:process";

export async function promptYes(question: string): Promise<boolean> {
  const answer = (await readLine(`${question} [yes/N]: `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

export async function promptStrictYes(question: string): Promise<boolean> {
  const answer = (await readLine(`${question} [type 'yes' to confirm]: `)).trim();
  return answer === "yes";
}

async function readLine(prompt: string): Promise<string> {
  stdout.write(prompt);
  return new Promise<string>((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newlineIdx = buf.indexOf("\n");
      if (newlineIdx >= 0) {
        const line = buf.slice(0, newlineIdx);
        stdin.off("data", onData);
        try {
          stdin.pause();
        } catch {
          // ignore — pause may throw if stdin already at EOF in tests
        }
        resolve(line.replace(/\r$/, ""));
      }
    };
    stdin.on("data", onData);
    try {
      stdin.resume();
    } catch {
      // pipe closed → resolve empty so the prompt doesn't hang
      resolve("");
    }
  });
}
