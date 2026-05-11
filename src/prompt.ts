/**
 * Tiny prompt helpers for interactive flows. All read from stdin and
 * write to stdout/stderr; no external dependencies.
 *
 * Modes:
 *  - `prompt(question)` — read a single line.
 *  - `promptYes(question)` — accepts `y` / `yes` (case-insensitive).
 *  - `promptStrictYes(question)` — requires the literal lowercase
 *    word `yes`. Used when a destructive op needs explicit consent.
 *  - `promptPassword(question)` — like `prompt` but the terminal is
 *    put into raw mode so keystrokes don't echo; each character is
 *    masked with `*` instead.
 */

import { stdin, stdout } from "node:process";

export async function prompt(question: string): Promise<string> {
  return (await readLine(`${question}: `)).trim();
}

export async function promptYes(question: string): Promise<boolean> {
  const answer = (await readLine(`${question} [yes/N]: `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

export async function promptStrictYes(question: string): Promise<boolean> {
  const answer = (await readLine(`${question} [type 'yes' to confirm]: `)).trim();
  return answer === "yes";
}

/**
 * Read a password from stdin without echoing the characters back. Each
 * keystroke is replaced with `*` so the user can see they're typing.
 * Handles backspace and Ctrl-C; falls back to a plain line-read if
 * stdin isn't a TTY (e.g. piped input in CI).
 */
export async function promptPassword(question: string): Promise<string> {
  if (!stdin.isTTY) {
    // No TTY → no point in raw mode. Fall back to plain line read;
    // the caller is expected to handle the trade-off (e.g. piping a
    // password through stdin in a script).
    return readLine(`${question}: `);
  }
  stdout.write(`${question}: `);
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer | string): void => {
      const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of data) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(buf);
          return;
        }
        if (code === 0x03) {
          // Ctrl-C — cancel.
          cleanup();
          stdout.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (code === 0x7f || code === 0x08) {
          // DEL (most terminals) or BS — treat both as backspace.
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (code < 0x20) continue; // skip other control bytes
        buf += ch;
        stdout.write("*");
      }
    };
    const cleanup = (): void => {
      try {
        stdin.setRawMode?.(false);
      } catch {
        // ignore
      }
      stdin.off("data", onData);
      try {
        stdin.pause();
      } catch {
        // ignore
      }
    };
    try {
      stdin.setRawMode?.(true);
    } catch {
      // already in cooked mode somehow; fall through anyway
    }
    stdin.on("data", onData);
    try {
      stdin.resume();
    } catch {
      resolve("");
    }
  });
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
