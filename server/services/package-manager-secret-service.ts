import {
  getLegacyCustomConfigKey,
  getSecretConfigEntries,
  listSecretRefCredentialIds,
  parsePackageManagerSecretRefs,
  type PackageManagerSecretRefs,
} from "../package-manager-configs";
import { SecretInput } from "../ssh/secret-input";
import {
  getCredentialRow,
  resolveSecretCredentialValue,
} from "./credential-service";
import { listPackageManagerDefinitions } from "./script-service";

export interface SudoEnvKeepEntry {
  envVar: string;
  pkgManager: string;
  key: string;
}

interface SecretRefSystem {
  pkgManagerSecretRefs?: string | null;
}

export function getSystemSecretRefs(system: SecretRefSystem | null | undefined): PackageManagerSecretRefs | null {
  return parsePackageManagerSecretRefs(system?.pkgManagerSecretRefs ?? null, listPackageManagerDefinitions());
}

/**
 * Build the secret environment for one package-manager operation on a system.
 * Returns null when the manager has no secret entries or none are assigned.
 */
export function resolveSecretInput(
  system: SecretRefSystem | null | undefined,
  pkgManager: string | null | undefined,
): SecretInput | null {
  if (!system || !pkgManager) return null;
  const definitions = listPackageManagerDefinitions();
  const definition = definitions.find((entry) => entry.name === pkgManager);
  const secretEntries = getSecretConfigEntries(definition);
  if (secretEntries.length === 0) return null;

  const refs = parsePackageManagerSecretRefs(system.pkgManagerSecretRefs ?? null, definitions)?.[pkgManager];
  if (!refs) return null;

  const entries = [];
  for (const entry of secretEntries) {
    const key = getLegacyCustomConfigKey(pkgManager, entry.key);
    const credentialId = refs[key];
    if (!credentialId || !entry.envVar) continue;
    let value: string | null;
    try {
      value = resolveSecretCredentialValue(credentialId);
    } catch {
      throw new Error(`Secret credential for ${pkgManager}.${key} could not be decrypted`);
    }
    if (value === null) {
      throw new Error(`Secret credential for ${pkgManager}.${key} is missing`);
    }
    entries.push({ envVar: entry.envVar, value });
  }
  return entries.length > 0 ? new SecretInput(entries) : null;
}

/** Display-only note prepended to commands so users can see a secret is in play. */
export function withSecretEnvNote(command: string, secretInput: SecretInput | null): string {
  if (!secretInput || secretInput.isEmpty) return command;
  return `# Secret environment (via stdin): ${secretInput.envVars.join(", ")}\n${command}`;
}

/** Secret entries of the given managers that must survive sudo's env_reset. */
export function listSudoEnvKeepEntries(managers: string[]): SudoEnvKeepEntry[] {
  const definitions = listPackageManagerDefinitions();
  const result: SudoEnvKeepEntry[] = [];
  const seen = new Set<string>();
  for (const manager of managers) {
    const definition = definitions.find((entry) => entry.name === manager);
    for (const entry of getSecretConfigEntries(definition)) {
      if (!entry.sudoEnvKeep || !entry.envVar || seen.has(entry.envVar)) continue;
      seen.add(entry.envVar);
      result.push({
        envVar: entry.envVar,
        pkgManager: manager,
        key: getLegacyCustomConfigKey(manager, entry.key),
      });
    }
  }
  return result;
}

export function validateSecretRefCredentials(refs: PackageManagerSecretRefs | null | undefined): string | null {
  for (const id of listSecretRefCredentialIds(refs)) {
    const row = getCredentialRow(id);
    if (!row) return `Secret credential ${id} does not exist`;
    if (row.kind !== "secret") return `Credential ${id} is not a secret credential`;
  }
  return null;
}
