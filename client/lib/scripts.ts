import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { CustomPackageManagerConfigEntry } from "./package-manager-configs";

export type ScriptType = "package_manager" | "system";
export type ScriptOperation =
  | "detect"
  | "check_updates"
  | "list_installed_packages"
  | "repair_issue"
  | "autoremove"
  | "upgrade_all"
  | "full_upgrade_all"
  | "upgrade_selected"
  | "system_info"
  | "reboot";

export interface ScriptStep {
  label: string;
  command: string;
}

export interface CustomParserConfig {
  parseStep?: number;
  updateRegex?: string;
  installedPackageRegex?: string;
  securityRegex?: string;
  keptBackRegex?: string;
  issueRegex?: string;
  issueTitle?: string;
  issueMessage?: string;
  successExitCodes?: number[];
  updatesExitCodes?: number[];
}

export interface CustomSystemInfoConfig {
  mode?: "builtin" | "sectioned";
  fieldSections?: Record<string, string>;
  rebootRequiredRegex?: string;
}

export interface ScriptDefinition {
  id: string;
  readonly: boolean;
  name: string;
  description: string | null;
  type: ScriptType;
  operation: ScriptOperation;
  pkgManager: string | null;
  isDefault?: boolean;
  steps: ScriptStep[];
  parserConfig: CustomParserConfig | null;
  systemInfoConfig: CustomSystemInfoConfig | null;
  sourceScriptId: string | null;
  usageCount?: number;
  usages?: ScriptUsage[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ScriptUsage {
  systemId: number;
  systemName: string;
  operationKey: string;
}

export interface ScriptOperationProfile {
  operation: ScriptOperation;
  label: string;
  allowedTypes: ScriptType[];
  purpose: string;
  stepBehavior: string;
  outputConsumer: string;
  parserBehavior: string;
  exitCodeBehavior: string;
  relevantPlaceholders: string[];
  defaultStepBadge: string;
}

export interface CustomPackageManagerDefinition {
  id: number;
  builtin: boolean;
  name: string;
  label: string;
  parserConfig: CustomParserConfig | null;
  configEntries: CustomPackageManagerConfigEntry[];
  createdAt?: string;
  updatedAt?: string;
}

export interface PlaceholderHelpEntry {
  name: string;
  description: string;
  example: string;
}

export interface ScriptsResponse {
  scripts: ScriptDefinition[];
  packageManagers: CustomPackageManagerDefinition[];
  placeholders: PlaceholderHelpEntry[];
  operationProfiles?: ScriptOperationProfile[];
}

export interface CustomPackageManagerBundle {
  format: "ludash.custom-package-manager.v1";
  exportedAt: string;
  packageManager: {
    name: string;
    label: string;
    parserConfig: CustomParserConfig | null;
    configEntries: CustomPackageManagerConfigEntry[];
  };
  scripts: Array<{
    name: string;
    description: string | null;
    type: "package_manager";
    operation: Exclude<ScriptOperation, "system_info" | "reboot">;
    pkgManager: string;
    isDefault: boolean;
    steps: ScriptStep[];
    parserConfig: CustomParserConfig | null;
    systemInfoConfig: null;
    sourceScriptId: string | null;
  }>;
}

export interface CustomPackageManagerImportResult {
  manager: CustomPackageManagerDefinition;
  scripts: ScriptDefinition[];
  createdScripts: number;
  updatedScripts: number;
}

export function buildOperationKey(operation: ScriptOperation, pkgManager?: string | null): string {
  return pkgManager ? `${pkgManager}/${operation}` : `system/${operation}`;
}

export function useScripts() {
  return useQuery({
    queryKey: ["scripts"],
    queryFn: () => apiFetch<ScriptsResponse>("/scripts"),
  });
}

export function useCreateScript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (script: Partial<ScriptDefinition>) =>
      apiFetch<{ script: ScriptDefinition }>("/scripts", {
        method: "POST",
        body: JSON.stringify(script),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scripts"] }),
  });
}

export function useUpdateScript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...script }: Partial<ScriptDefinition> & { id: string }) =>
      apiFetch<{ script: ScriptDefinition }>(`/scripts/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(script),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scripts"] }),
  });
}

export function useDeleteScript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/scripts/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scripts"] }),
  });
}

export function useCreatePackageManager() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (manager: {
      name: string;
      label: string;
      parserConfig?: CustomParserConfig | null;
      configEntries?: CustomPackageManagerConfigEntry[];
    }) =>
      apiFetch<{ manager: CustomPackageManagerDefinition }>("/scripts/package-managers", {
        method: "POST",
        body: JSON.stringify(manager),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scripts"] }),
  });
}

export function useUpdatePackageManager() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      name,
      ...manager
    }: {
      name: string;
      label: string;
      parserConfig?: CustomParserConfig | null;
      configEntries?: CustomPackageManagerConfigEntry[];
    }) =>
      apiFetch<{ manager: CustomPackageManagerDefinition }>(
        `/scripts/package-managers/${encodeURIComponent(name)}`,
        {
          method: "PUT",
          body: JSON.stringify(manager),
        },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scripts"] }),
  });
}

export function useDeletePackageManager() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: string | { name: string; deleteScripts?: boolean }) => {
      const name = typeof input === "string" ? input : input.name;
      const deleteScripts = typeof input === "string" ? false : input.deleteScripts === true;
      return apiFetch(`/scripts/package-managers/${encodeURIComponent(name)}`, {
        method: "DELETE",
        body: JSON.stringify({ deleteScripts }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scripts"] }),
  });
}

export function useImportPackageManagerBundle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bundle: CustomPackageManagerBundle | unknown) =>
      apiFetch<CustomPackageManagerImportResult>("/scripts/package-managers/import", {
        method: "POST",
        body: JSON.stringify(bundle),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scripts"] }),
  });
}

export function exportPackageManagerBundle(name: string): Promise<CustomPackageManagerBundle> {
  return apiFetch<CustomPackageManagerBundle>(
    `/scripts/package-managers/${encodeURIComponent(name)}/export`,
  );
}

export async function formatScriptCommand(command: string): Promise<string> {
  const response = await apiFetch<{ command: string }>("/scripts/format", {
    method: "POST",
    body: JSON.stringify({ command }),
  });
  return response.command;
}
