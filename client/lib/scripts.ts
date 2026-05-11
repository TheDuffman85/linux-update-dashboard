import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export type ScriptType = "package_manager" | "system";
export type ScriptOperation =
  | "detect"
  | "check_updates"
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
  securityRegex?: string;
  keptBackRegex?: string;
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
  steps: ScriptStep[];
  parserConfig: CustomParserConfig | null;
  systemInfoConfig: CustomSystemInfoConfig | null;
  sourceScriptId: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CustomPackageManagerDefinition {
  id: number;
  name: string;
  label: string;
  color: string | null;
  parserConfig: CustomParserConfig | null;
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
      color?: string | null;
      parserConfig?: CustomParserConfig | null;
    }) =>
      apiFetch<{ manager: CustomPackageManagerDefinition }>("/scripts/package-managers", {
        method: "POST",
        body: JSON.stringify(manager),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scripts"] }),
  });
}
