import { readFileSync } from "fs";

function hasEnv(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(process.env, name);
}

export function resolveSecretEnv(name: string): string | undefined {
  const fileName = `${name}_FILE`;
  const hasDirect = hasEnv(name);
  const hasFile = hasEnv(fileName);

  if (hasDirect && hasFile) {
    throw new Error(`Configuration error: both ${name} and ${fileName} are set. Set only one.`);
  }

  if (hasDirect) {
    return process.env[name];
  }

  if (!hasFile) {
    return undefined;
  }

  const filePath = process.env[fileName];
  if (!filePath) {
    throw new Error(`Configuration error: ${fileName} is set but empty.`);
  }

  try {
    const value = readFileSync(filePath, "utf8");
    return value.replace(/[\r\n]+$/g, "");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Configuration error: failed to read ${fileName} at "${filePath}": ${msg}`);
  }
}

export function resolveRequiredSecretEnv(name: string, helpText: string): string {
  const value = resolveSecretEnv(name);
  if (!value) {
    throw new Error(`${name} is required.\n${helpText}`);
  }
  return value;
}
