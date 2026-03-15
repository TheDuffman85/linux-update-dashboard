import { Hono } from "hono";
import * as systemService from "../services/system-service";
import * as cacheService from "../services/cache-service";
import * as hiddenUpdateService from "../services/hidden-update-service";
import * as updateService from "../services/update-service";
import * as notificationRuntime from "../services/notification-runtime";
import { getSSHManager } from "../ssh/connection";
import { detectPackageManagers } from "../ssh/detector";
import { validatePackageName } from "../ssh/parsers/types";
import * as outputStream from "../services/output-stream";
import { logger } from "../logger";
import { resolveSystemCredential } from "../services/credential-service";
import {
  clearTrustChallenge,
  getTrustChallenge,
  getValidatedConfig,
  issueTrustChallengeToken,
  issueValidatedConfigToken,
  type ApprovedHostKeyInput,
  type SystemConnectionConfig,
} from "../services/system-connection-validation";

const systems = new Hono();

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  if (isNaN(id) || id <= 0) return null;
  return id;
}

const VALID_HOSTNAME = /^[a-zA-Z0-9]([a-zA-Z0-9._:-]*[a-zA-Z0-9])?$/;

function validateSystemInput(body: Record<string, unknown>): string | null {
  if (!body.name || typeof body.name !== "string" || body.name.length > 255)
    return "name is required (max 255 chars)";
  if (!body.hostname || typeof body.hostname !== "string" || body.hostname.length > 255 || !VALID_HOSTNAME.test(body.hostname))
    return "hostname is required and must be a valid hostname or IP";
  if (body.port !== undefined && body.port !== null) {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return "port must be an integer between 1 and 65535";
  }
  const credentialId = Number(body.credentialId);
  if (!Number.isInteger(credentialId) || credentialId <= 0) {
    return "credentialId must be a positive integer";
  }
  if (
    body.proxyJumpSystemId !== undefined &&
    body.proxyJumpSystemId !== null &&
    !parseId(String(body.proxyJumpSystemId))
  ) {
    return "proxyJumpSystemId must be a positive integer";
  }
  if (
    body.hostKeyVerificationEnabled !== undefined &&
    typeof body.hostKeyVerificationEnabled !== "boolean"
  ) {
    return "hostKeyVerificationEnabled must be a boolean";
  }
  if (body.hidden !== undefined && typeof body.hidden !== "boolean") {
    return "hidden must be a boolean";
  }
  if (
    body.autoHideKeptBackUpdates !== undefined &&
    typeof body.autoHideKeptBackUpdates !== "boolean"
  ) {
    return "autoHideKeptBackUpdates must be a boolean";
  }
  if (
    body.validatedConfigToken !== undefined &&
    typeof body.validatedConfigToken !== "string"
  ) {
    return "validatedConfigToken must be a string";
  }
  return null;
}

function parseJsonArrayField(value: string | null): string[] | null {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function parseSystemIdList(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;

  const ids = value.map((entry) => parseId(String(entry)));
  if (ids.some((id) => id === null)) return null;

  return ids as number[];
}

function getSystemWriteErrorResponse(error: unknown): Response | null {
  if (error instanceof systemService.DuplicateSystemConnectionError) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  if (error instanceof Error && error.message.includes("credential")) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  if (error instanceof systemService.InvalidProxyJumpConfigurationError) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  if (error instanceof systemService.ProxyJumpDependencyError) {
    return new Response(
      JSON.stringify({
        error: error.message,
        dependents: error.dependents,
      }),
      {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  return null;
}

function serializeSystem(s: Record<string, unknown>) {
  const {
    encryptedPassword,
    encryptedPrivateKey,
    encryptedKeyPassphrase,
    encryptedSudoPassword,
    trustedHostKey,
    ...safe
  } = s;
  return {
    ...safe,
    hasSudoPassword: !!encryptedSudoPassword,
    approvedHostKey:
      typeof s.trustedHostKey === "string" &&
      typeof s.trustedHostKeyAlgorithm === "string"
        ? `${s.trustedHostKeyAlgorithm} ${s.trustedHostKey}`
        : null,
    detectedPkgManagers: parseJsonArrayField(s.detectedPkgManagers as string | null),
    disabledPkgManagers: parseJsonArrayField(s.disabledPkgManagers as string | null),
    hostKeyStatus: systemService.deriveHostKeyStatus({
      hostKeyVerificationEnabled: s.hostKeyVerificationEnabled as number | null,
      trustedHostKey: s.trustedHostKey as string | null,
    }),
    proxyJumpChain:
      typeof s.id === "number"
        ? systemService.getProxyJumpChain({
            proxyJumpSystemId: s.proxyJumpSystemId as number | null,
          })
        : [],
  };
}

function getValidationSubject(c: { get: (key: string) => unknown }): string | null {
  try {
    const user = c.get("user") as { userId?: number; username?: string } | undefined;
    if (!user?.userId) return null;
    return `${user.userId}:${user.username || ""}`;
  } catch {
    return null;
  }
}

function parseConnectionConfig(
  body: Record<string, unknown>,
  systemId?: number
): { config?: SystemConnectionConfig; error?: string } {
  const hostname = typeof body.hostname === "string" ? body.hostname : "";
  const port = body.port === undefined || body.port === null ? 22 : Number(body.port);
  const credentialId = Number(body.credentialId);
  const proxyJumpSystemId =
    body.proxyJumpSystemId === undefined || body.proxyJumpSystemId === null
      ? null
      : parseId(String(body.proxyJumpSystemId));
  const hostKeyVerificationEnabled =
    body.hostKeyVerificationEnabled === undefined
      ? true
      : body.hostKeyVerificationEnabled === true;

  if (!hostname || !VALID_HOSTNAME.test(hostname)) {
    return { error: "hostname is required and must be a valid hostname or IP" };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: "port must be an integer between 1 and 65535" };
  }
  if (!Number.isInteger(credentialId) || credentialId <= 0) {
    return { error: "credentialId must be a positive integer" };
  }
  if (
    body.proxyJumpSystemId !== undefined &&
    body.proxyJumpSystemId !== null &&
    !proxyJumpSystemId
  ) {
    return { error: "proxyJumpSystemId must be a positive integer" };
  }

  return {
    config: {
      systemId,
      hostname,
      port,
      credentialId,
      proxyJumpSystemId,
      hostKeyVerificationEnabled,
    },
  };
}

function parseApprovedHostKeys(value: unknown): ApprovedHostKeyInput[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;

  const approvals: ApprovedHostKeyInput[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const role = item.role === "jump" ? "jump" : item.role === "target" ? "target" : null;
    const port = Number(item.port);
    const systemId =
      item.systemId === undefined || item.systemId === null
        ? undefined
        : parseId(String(item.systemId));
    if (
      !role ||
      typeof item.host !== "string" ||
      !item.host ||
      !Number.isInteger(port) ||
      port < 1 ||
      typeof item.algorithm !== "string" ||
      !item.algorithm ||
      typeof item.fingerprintSha256 !== "string" ||
      !item.fingerprintSha256 ||
      typeof item.rawKey !== "string" ||
      !item.rawKey ||
      (item.systemId !== undefined && item.systemId !== null && !systemId)
    ) {
      return null;
    }
    approvals.push({
      systemId: systemId ?? undefined,
      role,
      host: item.host,
      port,
      algorithm: item.algorithm,
      fingerprintSha256: item.fingerprintSha256,
      rawKey: item.rawKey,
    });
  }

  return approvals;
}

function approvalsMatchChallenges(
  challenges: ApprovedHostKeyInput[],
  approvals: ApprovedHostKeyInput[]
): boolean {
  return challenges.every((challenge) =>
    approvals.some((approval) =>
      approval.role === challenge.role &&
      approval.host === challenge.host &&
      approval.port === challenge.port &&
      approval.fingerprintSha256 === challenge.fingerprintSha256 &&
      approval.rawKey === challenge.rawKey &&
      (approval.systemId ?? null) === (challenge.systemId ?? null)
    )
  );
}

// List all systems
systems.get("/", (c) => {
  const scope = c.req.query("scope");
  const allSystems = scope === "visible"
    ? systemService.listVisibleSystemsWithUpdateCounts()
    : systemService.listSystemsWithUpdateCounts();
  const systemsWithMeta = allSystems.map((s) => ({
    ...serializeSystem(s as Record<string, unknown>),
    cacheAge: cacheService.getCacheAge(s.id),
    activeOperation: updateService.getActiveOperation(s.id),
    supportsFullUpgrade: updateService.supportsFullUpgrade(s.id),
  }));
  return c.json({ systems: systemsWithMeta });
});

// Get single system detail
systems.get("/:id", (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const system = systemService.getSystemWithUpdateCount(id);
  if (!system) return c.json({ error: "System not found" }, 404);

  const updates = hiddenUpdateService.getVisibleCachedUpdates(id);
  const hiddenUpdates = hiddenUpdateService.listActiveHiddenUpdates(id);
  const history = updateService.getHistory(id, 20).map((h) => ({
    ...h,
    packagesList: h.packages ? JSON.parse(h.packages) : [],
  }));

  return c.json({
    system: {
      ...serializeSystem(system as Record<string, unknown>),
      cacheAge: cacheService.getCacheAge(id),
      isStale: cacheService.isCacheStale(id),
      activeOperation: updateService.getActiveOperation(id),
      supportsFullUpgrade: updateService.supportsFullUpgrade(id),
    },
    updates,
    hiddenUpdates,
    history,
  });
});

systems.post("/:id/hidden-updates", async (c) => {
  const systemId = parseId(c.req.param("id"));
  if (!systemId) return c.json({ error: "Invalid system ID" }, 400);

  const system = systemService.getSystem(systemId);
  if (!system) return c.json({ error: "System not found" }, 404);

  const body = await c.req.json();
  const pkgManager =
    typeof body.pkgManager === "string" ? body.pkgManager.trim() : "";
  const packageName =
    typeof body.packageName === "string" ? body.packageName.trim() : "";
  const newVersion =
    typeof body.newVersion === "string" ? body.newVersion.trim() : "";

  if (!pkgManager) return c.json({ error: "pkgManager is required" }, 400);
  if (!newVersion) return c.json({ error: "newVersion is required" }, 400);

  try {
    validatePackageName(packageName);
  } catch {
    return c.json({ error: "Invalid package name" }, 400);
  }

  const hiddenUpdate = hiddenUpdateService.createHiddenUpdate(systemId, {
    pkgManager,
    packageName,
    newVersion,
  });
  if (!hiddenUpdate) {
    return c.json({ error: "Update not found" }, 404);
  }

  return c.json({ hiddenUpdate }, 201);
});

systems.delete("/:id/hidden-updates/:hiddenUpdateId", (c) => {
  const systemId = parseId(c.req.param("id"));
  const hiddenUpdateId = parseId(c.req.param("hiddenUpdateId"));
  if (!systemId || !hiddenUpdateId) {
    return c.json({ error: "Invalid hidden update ID" }, 400);
  }

  const deleted = hiddenUpdateService.deleteHiddenUpdate(systemId, hiddenUpdateId);
  if (!deleted) {
    return c.json({ error: "Hidden update not found" }, 404);
  }

  return c.json({ status: "ok" });
});

// Create system
systems.post("/", async (c) => {
  const body = await c.req.json();
  const validationError = validateSystemInput(body);
  if (validationError) return c.json({ error: validationError }, 400);
  const sourceIdCandidate =
    body.sourceSystemId === undefined || body.sourceSystemId === null
      ? undefined
      : parseId(String(body.sourceSystemId));
  const sourceSystemId = sourceIdCandidate ?? undefined;
  if (body.sourceSystemId !== undefined && body.sourceSystemId !== null && !sourceIdCandidate) {
    return c.json({ error: "sourceSystemId must be a positive integer" }, 400);
  }
  const parsedConfig = parseConnectionConfig(body);
  if (!parsedConfig.config) {
    return c.json({ error: parsedConfig.error || "Invalid connection config" }, 400);
  }
  const validatedConfig =
    typeof body.validatedConfigToken === "string"
      ? getValidatedConfig(
          body.validatedConfigToken,
          parsedConfig.config,
          getValidationSubject(c)
        )
      : null;
  if (body.validatedConfigToken && !validatedConfig) {
    return c.json({ error: "The provided connection validation has expired. Test the connection again." }, 400);
  }

  let systemId: number;
  try {
    systemId = systemService.createSystem({
      name: body.name,
      hostname: parsedConfig.config.hostname,
      port: parsedConfig.config.port,
      credentialId: parsedConfig.config.credentialId,
      proxyJumpSystemId: parsedConfig.config.proxyJumpSystemId,
      hostKeyVerificationEnabled: parsedConfig.config.hostKeyVerificationEnabled,
      sudoPassword: body.sudoPassword || undefined,
      disabledPkgManagers: body.disabledPkgManagers ?? undefined,
      autoHideKeptBackUpdates: body.autoHideKeptBackUpdates,
      excludeFromUpgradeAll: body.excludeFromUpgradeAll,
      hidden: body.hidden,
      sourceSystemId,
      trustedHostKeyData: validatedConfig?.approvedTargetHostKey,
    });
  } catch (error) {
    const response = getSystemWriteErrorResponse(error);
    if (response) return response;
    throw error;
  }

  // Trigger initial check in background
  await notificationRuntime.syncSystemState(systemId);
  updateService.checkUpdates(systemId).catch((error) => {
    logger.error("Initial update check failed after system creation", {
      systemId,
      error: String(error),
    });
  });

  return c.json({ id: systemId }, 201);
});

// Reorder systems
systems.put("/reorder", async (c) => {
  const body = await c.req.json();
  const systemIds = parseSystemIdList(body.systemIds);

  if (!systemIds) {
    return c.json({ error: "systemIds must be an array of positive integers" }, 400);
  }

  try {
    systemService.reorderSystems(systemIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reorder systems";
    return c.json({ error: message }, 400);
  }

  return c.json({ status: "ok" });
});

// Update system
systems.put("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const body = await c.req.json();
  const validationError = validateSystemInput(body);
  if (validationError) return c.json({ error: validationError }, 400);
  const parsedConfig = parseConnectionConfig(body, id);
  if (!parsedConfig.config) {
    return c.json({ error: parsedConfig.error || "Invalid connection config" }, 400);
  }
  const validatedConfig =
    typeof body.validatedConfigToken === "string"
      ? getValidatedConfig(
          body.validatedConfigToken,
          parsedConfig.config,
          getValidationSubject(c)
        )
      : null;
  if (body.validatedConfigToken && !validatedConfig) {
    return c.json({ error: "The provided connection validation has expired. Test the connection again." }, 400);
  }

  try {
    systemService.updateSystem(id, {
      name: body.name,
      hostname: parsedConfig.config.hostname,
      port: parsedConfig.config.port,
      credentialId: parsedConfig.config.credentialId,
      proxyJumpSystemId: parsedConfig.config.proxyJumpSystemId,
      hostKeyVerificationEnabled: parsedConfig.config.hostKeyVerificationEnabled,
      sudoPassword: body.sudoPassword || undefined,
      disabledPkgManagers: body.disabledPkgManagers ?? undefined,
      autoHideKeptBackUpdates: body.autoHideKeptBackUpdates,
      excludeFromUpgradeAll: body.excludeFromUpgradeAll,
      hidden: body.hidden,
      trustedHostKeyData: validatedConfig?.approvedTargetHostKey,
    });
  } catch (error) {
    const response = getSystemWriteErrorResponse(error);
    if (response) return response;
    throw error;
  }

  if (body.autoHideKeptBackUpdates === true) {
    hiddenUpdateService.autoHideCachedKeptBackUpdates(id);
  }

  await notificationRuntime.syncSystemState(id);

  return c.json({ status: "ok" });
});

// Reboot system
systems.post("/:id/reboot", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const result = await updateService.rebootSystem(id);
  return c.json(result, result.success ? 200 : 500);
});

systems.post("/:id/revoke-host-key", (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const system = systemService.getSystem(id);
  if (!system) return c.json({ error: "System not found" }, 404);
  systemService.clearTrustedHostKey(id);
  return c.json({ status: "ok" });
});

// Delete system
systems.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  outputStream.removeStream(id);
  try {
    systemService.deleteSystem(id);
  } catch (error) {
    const response = getSystemWriteErrorResponse(error);
    if (response) return response;
    throw error;
  }
  await notificationRuntime.syncSystemState(id);
  return c.json({ status: "ok" });
});

// Test connection with provided credentials
systems.post("/test-connection", async (c) => {
  const body = await c.req.json();
  const systemId =
    body.systemId === undefined || body.systemId === null
      ? null
      : parseId(String(body.systemId));
  if (body.systemId !== undefined && body.systemId !== null && !systemId) {
    return c.json({ error: "systemId must be a positive integer" }, 400);
  }
  const sourceSystemId =
    body.sourceSystemId === undefined || body.sourceSystemId === null
      ? null
      : parseId(String(body.sourceSystemId));
  if (body.sourceSystemId !== undefined && body.sourceSystemId !== null && !sourceSystemId) {
    return c.json({ error: "sourceSystemId must be a positive integer" }, 400);
  }
  const parsedConfig = parseConnectionConfig(body, systemId ?? undefined);
  if (!parsedConfig.config) {
    return c.json({ error: parsedConfig.error || "Invalid connection config" }, 400);
  }
  try {
    systemService.validateProxyJumpConfiguration(
      parsedConfig.config.proxyJumpSystemId ?? null,
      systemId ?? undefined
    );
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid ProxyJump configuration" }, 400);
  }

  const credential = resolveSystemCredential(parsedConfig.config.credentialId);
  if (!credential) {
    return c.json({ error: "Selected credential is not valid for system SSH access" }, 400);
  }
  const hostKeySourceSystemId = sourceSystemId ?? systemId;
  const existingSystem = hostKeySourceSystemId
    ? systemService.getSystem(hostKeySourceSystemId)
    : null;
  const approvedHostKeys = parseApprovedHostKeys(body.approvedHostKeys);
  if (!approvedHostKeys) {
    return c.json({ error: "approvedHostKeys must be an array of host-key approvals" }, 400);
  }

  const system: Record<string, unknown> = {
    hostname: parsedConfig.config.hostname,
    port: parsedConfig.config.port,
    credentialId: parsedConfig.config.credentialId,
    proxyJumpSystemId: parsedConfig.config.proxyJumpSystemId,
    hostKeyVerificationEnabled: parsedConfig.config.hostKeyVerificationEnabled,
    username: credential.username,
    authType: credential.authType,
    trustedHostKey:
      existingSystem &&
      existingSystem.hostname === parsedConfig.config.hostname &&
      existingSystem.port === parsedConfig.config.port
        ? existingSystem.trustedHostKey
        : null,
  };

  if (body.trustChallengeToken !== undefined && typeof body.trustChallengeToken !== "string") {
    return c.json({ error: "trustChallengeToken must be a string" }, 400);
  }

  if (body.trustChallengeToken) {
    const challenges = getTrustChallenge(
      String(body.trustChallengeToken),
      parsedConfig.config,
      getValidationSubject(c)
    );
    if (!challenges) {
      return c.json({ error: "Host-key approval session expired. Test the connection again." }, 400);
    }
    if (!approvalsMatchChallenges(challenges, approvedHostKeys)) {
      return c.json({ error: "Host-key approvals do not match the requested trust challenge." }, 400);
    }
    for (const approval of approvedHostKeys) {
      if (approval.systemId) {
        systemService.persistTrustedHostKey(approval.systemId, approval);
      }
    }
    clearTrustChallenge(String(body.trustChallengeToken));
  } else if (approvedHostKeys.length > 0) {
    return c.json({ error: "approvedHostKeys require a trustChallengeToken" }, 400);
  }

  const sshManager = getSSHManager();
  const result = await sshManager.testConnection(system, {
    systemId: systemId ?? undefined,
    approvedHostKeys,
  });

  if (result.hostKeyChallenges?.length) {
    return c.json({
      ...result,
      trustChallengeToken: issueTrustChallengeToken(
        parsedConfig.config,
        result.hostKeyChallenges,
        getValidationSubject(c)
      ),
    });
  }

  // On successful connection, also detect available package managers
  if (result.success) {
    const validatedConfigToken = issueValidatedConfigToken(
      parsedConfig.config,
      getValidationSubject(c),
      approvedHostKeys.find((approval) => approval.role === "target")
    );
    try {
      const conn = await sshManager.connect(system, {
        systemId: systemId ?? undefined,
        approvedHostKeys,
      });
      try {
        const detectedManagers = await detectPackageManagers(sshManager, conn);
        return c.json({ ...result, detectedManagers, validatedConfigToken });
      } finally {
        sshManager.disconnect(conn);
      }
    } catch {
      // Detection failed but connection test succeeded — return without managers
      return c.json({ ...result, detectedManagers: [], validatedConfigToken });
    }
  }

  return c.json(result);
});

// Get cached updates for system
systems.get("/:id/updates", (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const updates = cacheService.getCachedUpdates(id);
  return c.json({ updates });
});

// Get history for system
systems.get("/:id/history", (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const history = updateService.getHistory(id).map((h) => ({
    ...h,
    packagesList: h.packages ? JSON.parse(h.packages) : [],
  }));
  return c.json({ history });
});

export default systems;
