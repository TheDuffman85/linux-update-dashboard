import { inspect } from "util";

export interface SecretEnvEntry {
  envVar: string;
  value: string;
}

const ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
// Very short values would garble unrelated output if redacted, so they are
// still delivered but not masked. Credential validation keeps this rare.
export const MIN_REDACTED_SECRET_LENGTH = 6;
const REDACTION = "***";

/**
 * Secret environment for one remote command.
 *
 * Values are delivered on the SSH channel's stdin (ahead of an optional sudo
 * password) and read by a preamble that only contains variable names, so
 * they never appear in the command text, `ps` output, persisted scripts,
 * history, or the command echoed to the browser.
 */
export class SecretInput {
  readonly #entries: SecretEnvEntry[];

  constructor(entries: SecretEnvEntry[]) {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!ENV_VAR_PATTERN.test(entry.envVar)) {
        throw new Error(`Invalid secret environment variable name: ${entry.envVar}`);
      }
      if (seen.has(entry.envVar)) {
        throw new Error(`Duplicate secret environment variable: ${entry.envVar}`);
      }
      if (/[\r\n\0]/.test(entry.value)) {
        throw new Error(`Secret for ${entry.envVar} must be a single line`);
      }
      seen.add(entry.envVar);
    }
    this.#entries = entries.map((entry) => ({ ...entry }));
  }

  get envVars(): string[] {
    return this.#entries.map((entry) => entry.envVar);
  }

  get isEmpty(): boolean {
    return this.#entries.length === 0;
  }

  /** Shell lines that read each value from stdin. Contains names only. */
  preamble(): string {
    if (this.isEmpty) return "";
    return [
      "# Secret environment: values arrive on stdin, never in this script.",
      ...this.#entries.map(({ envVar }) =>
        `IFS= read -r ${envVar} || ${envVar}=''; export ${envVar}`
      ),
      "",
    ].join("\n");
  }

  /** Data written to stdin before anything else (e.g. the sudo password). */
  stdinPrefix(): string {
    return this.#entries.map((entry) => `${entry.value}\n`).join("");
  }

  createRedactor(): StreamRedactor {
    return new StreamRedactor(this.#entries.map((entry) => entry.value));
  }

  redact(text: string): string {
    return redactSecretValues(text, this.#entries.map((entry) => entry.value));
  }

  toJSON(): { envVars: string[] } {
    return { envVars: this.envVars };
  }

  toString(): string {
    return `[SecretInput ${this.envVars.join(", ")}]`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

function redactableValues(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length >= MIN_REDACTED_SECRET_LENGTH))]
    // Longest first so a value that contains another is masked whole.
    .sort((a, b) => b.length - a.length);
}

export function redactSecretValues(text: string, values: string[]): string {
  let result = text;
  for (const value of redactableValues(values)) {
    result = result.split(value).join(REDACTION);
  }
  return result;
}

/**
 * Redacts secret values from a chunked stream. A value split across chunk
 * boundaries is caught by holding back the shortest tail that could still be
 * the start of a secret; ordinary output passes through without delay.
 */
export class StreamRedactor {
  readonly #values: string[];
  #pending = "";

  constructor(values: string[]) {
    this.#values = redactableValues(values);
  }

  push(chunk: string): string {
    if (this.#values.length === 0) return chunk;
    const text = redactSecretValues(this.#pending + chunk, this.#values);
    const hold = this.#holdbackLength(text);
    this.#pending = text.slice(text.length - hold);
    return text.slice(0, text.length - hold);
  }

  flush(): string {
    const rest = this.#pending;
    this.#pending = "";
    return rest;
  }

  #holdbackLength(text: string): number {
    const maxHold = Math.min(
      text.length,
      Math.max(0, ...this.#values.map((value) => value.length - 1)),
    );
    for (let length = maxHold; length > 0; length--) {
      const tail = text.slice(text.length - length);
      if (this.#values.some((value) => value.startsWith(tail))) return length;
    }
    return 0;
  }
}
