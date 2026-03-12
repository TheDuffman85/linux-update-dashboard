import { eq } from "drizzle-orm";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { notifications, apiTokens } from "../db/schema";
import { getDb } from "../db";
import { logger } from "../logger";
import { config } from "../config";
import { sanitizeOutput } from "../utils/sanitize";
import { generateApiToken, hashToken } from "../auth/api-token";
import {
  prepareTelegramConfigForStorage,
  readTelegramConfig,
  resolveTelegramBotToken,
  resolveTelegramCommandToken,
  type TelegramConfig,
} from "./notifications/telegram";
import { formatUpdateCounts } from "./notifications/presentation";

const TELEGRAM_TYPE = "telegram";
const LINK_TTL_MS = 10 * 60_000;
const CONFIRM_TTL_MS = 5 * 60_000;
const POLL_TIMEOUT_SECONDS = 30;
const MAX_MESSAGE_LENGTH = 3500;
const JOB_POLL_INTERVAL_MS = 2000;
const JOB_POLL_ATTEMPTS = 300;
const MENU_PAGE_SIZE = 8;
const PACKAGE_MENU_PAGE_SIZE = 8;
const TELEGRAM_PROFILE_PHOTO_FILENAME = "telegram-bot-avatar.jpg";
const TELEGRAM_COMMANDS = [
  { command: "help", description: "Show supported commands" },
  { command: "menu", description: "Open the action menu" },
] as const;

type NotificationRow = typeof notifications.$inferSelect;

interface LinkRequest {
  notificationId: number;
  botToken: string;
  actorUserId: number;
  expiresAt: number;
}

interface PendingConfirmation {
  notificationId: number;
  chatId: string;
  botToken: string;
  actorUserId: number;
  command: "upgrade" | "full-upgrade" | "upgrade-package" | "upgrade-all" | "full-upgrade-all";
  systemId?: number;
  targetSystems?: Array<{ id: number; name: string }>;
  packageName?: string;
  expiresAt: number;
}

interface TelegramUser {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramChat {
  id?: number | string;
  type?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
}

interface TelegramMessage {
  message_id?: number;
  text?: string;
  chat?: TelegramChat;
  from?: TelegramUser;
}

interface TelegramCallbackQuery {
  id?: string;
  data?: string;
  from?: TelegramUser;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface WorkerState {
  stop: boolean;
  offset: number;
}

interface AllowedSystem {
  id: number;
  name: string;
  updateCount?: number;
  securityCount?: number;
  isReachable?: number;
  supportsFullUpgrade?: boolean;
}

interface SystemUpdate {
  packageName: string;
  currentVersion?: string | null;
  newVersion?: string | null;
}

type SystemAction = "check" | "upgrade" | "fullupgrade" | "pkgsys" | "pkglist";
type BulkAction = "check" | "upgrade" | "fullupgrade";

class DashboardApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
  }
}

const linkRequests = new Map<string, LinkRequest>();
const pendingConfirmations = new Map<string, PendingConfirmation>();
const workers = new Map<string, WorkerState>();
const syncedProfilePhotos = new Set<string>();
let started = false;
const COMMAND_TOKEN_AUTH_FAILURE_MESSAGE =
  "Telegram bot command authentication failed. The command token is missing, expired, or revoked. Reissue it in the Telegram notification settings.";
let botProfilePhotoPath: string | null | undefined;

function nowSql(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateMessage(value: string): string {
  return value.length > MAX_MESSAGE_LENGTH
    ? `${value.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : value;
}

function parseConfig(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadTelegramConfig(row: NotificationRow): TelegramConfig {
  return readTelegramConfig(parseConfig(row.config));
}

function privateChatIdFrom(update: TelegramUpdate): string | null {
  const chat = update.callback_query?.message?.chat || update.message?.chat;
  if (!chat || chat.type !== "private" || chat.id === undefined || chat.id === null) return null;
  return String(chat.id);
}

function formatDisplayName(user?: TelegramUser, chat?: TelegramChat): string {
  const first = user?.first_name || chat?.first_name || "";
  const last = user?.last_name || chat?.last_name || "";
  const fullName = [first, last].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;
  if (user?.username) return `@${user.username}`;
  if (chat?.username) return `@${chat.username}`;
  if (chat?.title) return chat.title;
  return "Telegram user";
}

function cleanupExpiringState(): void {
  const now = Date.now();
  for (const [nonce, request] of linkRequests) {
    if (request.expiresAt <= now) linkRequests.delete(nonce);
  }
  for (const [token, confirmation] of pendingConfirmations) {
    if (confirmation.expiresAt <= now) pendingConfirmations.delete(token);
  }
}

async function telegramApi(
  botToken: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : "{}",
  });
}

async function telegramApiFormData(
  botToken: string,
  method: string,
  body: FormData,
): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    body,
  });
}

async function syncBotCommands(botToken: string): Promise<void> {
  const res = await telegramApi(botToken, "setMyCommands", {
    commands: TELEGRAM_COMMANDS,
  });
  const body = await res.json().catch(() => null) as { ok?: boolean; description?: string } | null;
  if (!res.ok || !body?.ok) {
    throw new Error(body?.description || `Telegram setMyCommands failed (${res.status})`);
  }
}

async function sendTelegramText(botToken: string, chatId: string, text: string, replyMarkup?: unknown): Promise<void> {
  await telegramApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: truncateMessage(text),
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
  }).catch((error) => {
    logger.error("Telegram sendMessage failed", { error: String(error) });
  });
}

async function sendTelegramHtml(botToken: string, chatId: string, html: string, replyMarkup?: unknown): Promise<void> {
  await telegramApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: truncateMessage(html),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
  }).catch((error) => {
    logger.error("Telegram sendMessage failed", { error: String(error) });
  });
}

async function answerCallback(botToken: string, callbackId: string, text?: string): Promise<void> {
  await telegramApi(botToken, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
  }).catch((error) => {
    logger.error("Telegram answerCallbackQuery failed", { error: String(error) });
  });
}

async function getBotUsername(botToken: string): Promise<string> {
  const res = await telegramApi(botToken, "getMe");
  const body = await res.json().catch(() => null) as { ok?: boolean; result?: { username?: string }; description?: string } | null;
  if (!res.ok || !body?.ok || !body.result?.username) {
    throw new Error(body?.description || `Telegram getMe failed (${res.status})`);
  }
  return body.result.username;
}

function resolveBotProfilePhotoPath(): string | null {
  if (botProfilePhotoPath !== undefined) return botProfilePhotoPath;

  const moduleCandidates = [
    new URL(`../assets/${TELEGRAM_PROFILE_PHOTO_FILENAME}`, import.meta.url),
    new URL(`../../../server/assets/${TELEGRAM_PROFILE_PHOTO_FILENAME}`, import.meta.url),
  ];

  for (const candidate of moduleCandidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) {
      botProfilePhotoPath = path;
      return path;
    }
  }

  const cwdCandidates = [
    resolve(process.cwd(), "server/assets", TELEGRAM_PROFILE_PHOTO_FILENAME),
    resolve(process.cwd(), "dist/server/assets", TELEGRAM_PROFILE_PHOTO_FILENAME),
  ];

  for (const candidate of cwdCandidates) {
    if (existsSync(candidate)) {
      botProfilePhotoPath = candidate;
      return candidate;
    }
  }

  botProfilePhotoPath = null;
  return null;
}

async function syncBotProfilePhoto(botToken: string): Promise<void> {
  if (syncedProfilePhotos.has(botToken)) return;

  const photoPath = resolveBotProfilePhotoPath();
  if (!photoPath) {
    logger.warn("Telegram bot profile photo asset not found", {
      file: TELEGRAM_PROFILE_PHOTO_FILENAME,
    });
    return;
  }

  try {
    const photoBuffer = await readFile(photoPath);
    const form = new FormData();
    form.set("photo", JSON.stringify({
      type: "static",
      photo: "attach://avatar",
    }));
    form.set("avatar", new File([photoBuffer], TELEGRAM_PROFILE_PHOTO_FILENAME, {
      type: "image/jpeg",
    }));

    const res = await telegramApiFormData(botToken, "setMyProfilePhoto", form);
    const body = await res.json().catch(() => null) as { ok?: boolean; description?: string } | null;
    if (!res.ok || !body?.ok) {
      throw new Error(body?.description || `Telegram setMyProfilePhoto failed (${res.status})`);
    }

    syncedProfilePhotos.add(botToken);
  } catch (error) {
    logger.warn("Telegram bot profile photo sync failed", {
      error: String(error),
    });
  }
}

async function callDashboardApi<T>(
  commandToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${commandToken}`);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new DashboardApiError(res.status, body.error || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function isCommandTokenAuthError(error: unknown): boolean {
  return error instanceof DashboardApiError && (error.status === 401 || error.status === 403);
}

async function sendCommandExecutionError(botToken: string, chatId: string, error: unknown): Promise<void> {
  if (isCommandTokenAuthError(error)) {
    await sendTelegramText(botToken, chatId, COMMAND_TOKEN_AUTH_FAILURE_MESSAGE);
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  await sendTelegramText(botToken, chatId, `Command failed: ${sanitizeOutput(truncateMessage(message))}`);
}

function getTelegramRows(): NotificationRow[] {
  return getDb()
    .select()
    .from(notifications)
    .where(eq(notifications.type, TELEGRAM_TYPE))
    .all();
}

async function revokeCommandToken(config: TelegramConfig): Promise<void> {
  if (!config.commandApiTokenId) return;
  getDb().delete(apiTokens).where(eq(apiTokens.id, config.commandApiTokenId)).run();
}

function configsEqual(a: TelegramConfig, b: TelegramConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function writeTelegramConfig(notificationId: number, nextConfig: TelegramConfig): void {
  getDb().update(notifications)
    .set({
      config: JSON.stringify(prepareTelegramConfigForStorage(nextConfig)),
      updatedAt: nowSql(),
    })
    .where(eq(notifications.id, notificationId))
    .run();
}

function buildTokenName(notificationId: number, chatId: string): string {
  return `telegram:${notificationId}:${chatId}`.slice(0, 50);
}

async function ensureCommandToken(
  notificationId: number,
  actorUserId: number,
  currentConfig: TelegramConfig,
): Promise<TelegramConfig> {
  if (!currentConfig.chatId) return currentConfig;
  if (currentConfig.commandApiTokenId && currentConfig.commandApiTokenEncrypted) {
    return currentConfig;
  }

  const plainToken = generateApiToken();
  const tokenHash = await hashToken(plainToken);
  const result = getDb().insert(apiTokens).values({
    userId: actorUserId,
    name: buildTokenName(notificationId, currentConfig.chatId),
    tokenHash,
    readOnly: 0,
    expiresAt: null,
  }).returning({ id: apiTokens.id }).get();

  return {
    ...currentConfig,
    commandApiTokenEncrypted: plainToken,
    commandApiTokenId: result.id,
  };
}

async function reconcileTelegramConfig(
  notificationId: number,
  previousConfig: TelegramConfig | null,
  currentConfig: TelegramConfig,
  actorUserId?: number,
): Promise<void> {
  const previousBotToken = previousConfig?.telegramBotToken ? resolveTelegramBotToken(previousConfig as unknown as Record<string, unknown>) : null;
  const currentBotToken = currentConfig.telegramBotToken ? resolveTelegramBotToken(currentConfig as unknown as Record<string, unknown>) : null;
  const botChanged = previousConfig !== null && previousBotToken !== currentBotToken;

  let nextConfig: TelegramConfig = { ...currentConfig };
  let changed = false;

  if (botChanged) {
    await revokeCommandToken(nextConfig);
    nextConfig = {
      ...nextConfig,
      botUsername: undefined,
      chatId: undefined,
      chatDisplayName: undefined,
      chatBoundAt: undefined,
      chatBindingStatus: "unbound",
      commandApiTokenEncrypted: undefined,
      commandApiTokenId: undefined,
    };
    changed = true;
  }

  const shouldHaveCommandToken =
    nextConfig.commandsEnabled === true &&
    !!nextConfig.chatId &&
    !!nextConfig.telegramBotToken;

  if (!shouldHaveCommandToken) {
    if (nextConfig.commandApiTokenId || nextConfig.commandApiTokenEncrypted) {
      await revokeCommandToken(nextConfig);
      nextConfig = {
        ...nextConfig,
        commandApiTokenEncrypted: undefined,
        commandApiTokenId: undefined,
      };
      changed = true;
    }
  } else if ((!nextConfig.commandApiTokenEncrypted || !nextConfig.commandApiTokenId) && actorUserId) {
    nextConfig = await ensureCommandToken(notificationId, actorUserId, nextConfig);
    changed = true;
  }

  if (!nextConfig.chatId && nextConfig.chatBindingStatus !== "pending") {
    nextConfig.chatBindingStatus = "unbound";
  }

  if (changed || !configsEqual(currentConfig, nextConfig)) {
    writeTelegramConfig(notificationId, nextConfig);
  }
}

function stopWorker(botToken: string): void {
  const worker = workers.get(botToken);
  if (!worker) return;
  worker.stop = true;
  workers.delete(botToken);
}

async function handleLinkStart(
  botToken: string,
  chatId: string,
  nonce: string,
  update: TelegramUpdate,
): Promise<void> {
  const request = linkRequests.get(nonce);
  if (!request || request.expiresAt <= Date.now() || request.botToken !== botToken) {
    await sendTelegramText(botToken, chatId, "This connect link is invalid or has expired.");
    return;
  }
  linkRequests.delete(nonce);

  const row = getDb().select().from(notifications).where(eq(notifications.id, request.notificationId)).get();
  if (!row || row.type !== TELEGRAM_TYPE) {
    await sendTelegramText(botToken, chatId, "This Telegram notification no longer exists.");
    return;
  }

  const currentConfig = loadTelegramConfig(row);
  const nextConfig: TelegramConfig = {
    ...currentConfig,
    chatId,
    chatDisplayName: formatDisplayName(update.message?.from, update.message?.chat),
    chatBoundAt: nowIso(),
    chatBindingStatus: "bound",
  };
  writeTelegramConfig(row.id, nextConfig);
  await reconcileTelegramConfig(row.id, currentConfig, nextConfig, request.actorUserId);
  await sync();
  await sendTelegramText(botToken, chatId, "Telegram chat connected to Linux Update Dashboard.");
}

async function fetchAllowedSystems(channel: NotificationRow): Promise<AllowedSystem[]> {
  const commandToken = resolveTelegramCommandToken(parseConfig(channel.config));
  if (!commandToken) return [];

  const response = await callDashboardApi<{ systems: Array<{ id: number; name: string; updateCount: number; securityCount?: number; isReachable: number; supportsFullUpgrade?: boolean }> }>(
    commandToken,
    "/api/systems?scope=visible"
  );
  // Preserve the dashboard/system sort order returned by the API, even when the channel scope is a subset.
  const scopedIds = channel.systemIds ? new Set<number>(JSON.parse(channel.systemIds)) : null;
  return response.systems.filter((system) => scopedIds === null || scopedIds.has(system.id));
}

async function fetchSystemUpdates(channel: NotificationRow, systemId: number): Promise<SystemUpdate[]> {
  const commandToken = resolveTelegramCommandToken(parseConfig(channel.config));
  if (!commandToken) return [];

  const response = await callDashboardApi<{ updates: SystemUpdate[] }>(
    commandToken,
    `/api/systems/${systemId}`
  );
  return Array.isArray(response.updates) ? response.updates : [];
}

async function fetchPackageNames(channel: NotificationRow, systemId: number): Promise<string[]> {
  const updates = await fetchSystemUpdates(channel, systemId);
  return [...new Set(
    updates
      .map((entry) => entry.packageName)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  )];
}

async function findCommandChannel(botToken: string, chatId: string): Promise<NotificationRow | null> {
  const rows = getTelegramRows().filter((row) => {
    if (row.enabled !== 1) return false;
    const telegram = loadTelegramConfig(row);
    if (!telegram.commandsEnabled || telegram.chatId !== chatId) return false;
    return resolveTelegramBotToken(telegram as unknown as Record<string, unknown>) === botToken;
  });

  if (rows.length !== 1) return null;
  return rows[0];
}

function parseCommand(text: string): { command: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const parts = trimmed.split(/\s+/);
  const rawCommand = parts[0].slice(1).split("@")[0].toLowerCase();
  return {
    command: rawCommand,
    args: parts.slice(1),
  };
}

function systemLookupKey(input: string): string {
  return input.trim().toLowerCase();
}

function resolveSystem(
  systemsList: AllowedSystem[],
  raw: string | undefined,
): AllowedSystem | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const id = Number.parseInt(raw, 10);
    return systemsList.find((system) => system.id === id) || null;
  }
  const key = systemLookupKey(raw);
  const exact = systemsList.filter((system) => systemLookupKey(system.name) === key);
  return exact.length === 1 ? exact[0] : null;
}

function formatSystemLabel(system: Pick<AllowedSystem, "id" | "name">): string {
  return `${system.name} (#${system.id})`;
}

function escapeTelegramHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatPackageUpdateEntry(update: SystemUpdate): string {
  const currentVersion = typeof update.currentVersion === "string" && update.currentVersion.length > 0
    ? update.currentVersion
    : null;
  const newVersion = typeof update.newVersion === "string" && update.newVersion.length > 0
    ? update.newVersion
    : null;

  if (currentVersion && newVersion) {
    return `- ${update.packageName}: ${currentVersion} -> ${newVersion}`;
  }
  if (newVersion) {
    return `- ${update.packageName}: -> ${newVersion}`;
  }
  if (currentVersion) {
    return `- ${update.packageName}: ${currentVersion}`;
  }
  return `- ${update.packageName}`;
}

function formatReachabilityDot(isReachable?: number): string {
  return isReachable === -1
    ? "🔴"
    : isReachable === 1
      ? "🟢"
      : "🟠";
}

function buildRefreshFailureMessage(system: Pick<AllowedSystem, "id" | "name">): string {
  return `Refresh failed for ${system.name} (#${system.id}). Check the dashboard history for details.`;
}

function filterSystemsForAction(
  systemsList: AllowedSystem[],
  action: SystemAction | BulkAction,
): AllowedSystem[] {
  return systemsList.filter((system) =>
    action === "fullupgrade"
      ? system.supportsFullUpgrade === true && (system.updateCount ?? 0) > 0
      : action === "upgrade" || action === "pkgsys" || action === "pkglist"
        ? (system.updateCount ?? 0) > 0
        : true
  );
}

async function getSystemsForAction(
  channel: NotificationRow,
  action: SystemAction | BulkAction,
): Promise<AllowedSystem[]> {
  const systems = await fetchAllowedSystems(channel);
  if (action === "check") return systems;
  return filterSystemsForAction(systems, action);
}

async function revalidatePendingConfirmation(
  channel: NotificationRow,
  pending: PendingConfirmation,
): Promise<
  | { ok: true; systemId?: number; systemName?: string; targetSystems?: Array<{ id: number; name: string }> }
  | { ok: false; message: string }
> {
  const allowedSystems = await fetchAllowedSystems(channel);
  const allowedById = new Map(allowedSystems.map((system) => [system.id, system]));

  if (pending.command === "upgrade" || pending.command === "full-upgrade" || pending.command === "upgrade-package") {
    if (!pending.systemId) {
      return { ok: false, message: "This confirmation is missing a target system." };
    }
    const system = allowedById.get(pending.systemId);
    if (!system) {
      return { ok: false, message: "This system is no longer allowed for this Telegram command channel." };
    }
    return { ok: true, systemId: system.id, systemName: system.name };
  }

  const targetSystems = (pending.targetSystems ?? [])
    .map((system) => allowedById.get(system.id))
    .filter((system): system is AllowedSystem => !!system)
    .map((system) => ({ id: system.id, name: system.name }));

  if (targetSystems.length === 0) {
    return { ok: false, message: "No selected systems are still allowed for this Telegram command channel." };
  }

  return { ok: true, targetSystems };
}

function noSystemsMessage(action: SystemAction | BulkAction): string {
  return action === "fullupgrade"
    ? "No systems in this Telegram command channel currently have updates and support full upgrade."
    : action === "upgrade"
      ? "No systems in this Telegram command channel currently have available updates."
      : action === "pkgsys"
        ? "No systems in this Telegram command channel currently have packages available to upgrade."
        : action === "pkglist"
          ? "No systems in this Telegram command channel currently have package updates."
        : "No systems are available for this Telegram command channel.";
}

function buildBulkConfirmationPrompt(action: Exclude<BulkAction, "check">, systems: AllowedSystem[]): string {
  const actionLabel = action === "upgrade" ? "upgrade all" : "full upgrade all";
  const preview = systems.slice(0, 5).map((system) => `- ${formatSystemLabel(system)}`).join("\n");
  const suffix = systems.length > 5 ? `\n…and ${systems.length - 5} more systems.` : "";
  return [
    `Confirm ${actionLabel} for ${formatCount(systems.length, "system")}?`,
    preview,
    suffix,
  ].filter(Boolean).join("\n");
}

function buildBulkStartedMessage(action: BulkAction, count: number, failedStarts: number): string {
  const label =
    action === "check"
      ? "Refresh all"
      : action === "upgrade"
        ? "Upgrade all"
        : "Full upgrade all";
  const failures = failedStarts > 0 ? ` ${formatCount(failedStarts, "system")} failed to start.` : "";
  return `${label} started for ${formatCount(count, "system")}.${failures}`;
}

function buildBulkSummaryMessage(
  action: BulkAction,
  totalCount: number,
  lines: string[],
  successCount: number,
  warningCount: number,
  failedCount: number,
): string {
  const label =
    action === "check"
      ? "Refresh all"
      : action === "upgrade"
        ? "Upgrade all"
        : "Full upgrade all";
  const visibleLines = lines.slice(0, 12);
  const extraLineCount = lines.length - visibleLines.length;
  return [
    `${label} finished for ${formatCount(totalCount, "system")}.`,
    `Success: ${successCount}, warnings: ${warningCount}, failed: ${failedCount}`,
    visibleLines.join("\n"),
    extraLineCount > 0 ? `…and ${extraLineCount} more result lines.` : "",
  ].filter(Boolean).join("\n");
}

function helpText(): string {
  return [
    "Supported commands:",
    "/help",
    "/menu",
    "/status",
    "/refresh <system-id|all>",
    "/packages <system-id>",
    "/upgrade <system-id|all>",
    "/fullupgrade <system-id|all>",
    "/upgradepkg <system-id> <package>",
    "",
    "Use 'all' to target every allowed system for that action.",
    "Mutating commands require Telegram confirmation before execution.",
  ].join("\n");
}

function buildConfirmationKeyboard(confirmationToken: string) {
  return {
    inline_keyboard: [[
      { text: "Confirm", callback_data: `confirm:${confirmationToken}` },
      { text: "Cancel", callback_data: `cancel:${confirmationToken}` },
    ]],
  };
}

function clampPage(value: number, totalItems: number, pageSize: number): number {
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  return Math.max(0, Math.min(value, pageCount - 1));
}

function pageLabel(totalItems: number, pageSize: number, page: number): string {
  const current = clampPage(page, totalItems, pageSize) + 1;
  const total = Math.max(1, Math.ceil(totalItems / pageSize));
  return `Page ${current}/${total}`;
}

function buildSystemMenuKeyboard(
  action: SystemAction,
  systemsList: AllowedSystem[],
  page = 0,
) {
  const safePage = clampPage(page, systemsList.length, MENU_PAGE_SIZE);
  const start = safePage * MENU_PAGE_SIZE;
  const pageItems = systemsList.slice(start, start + MENU_PAGE_SIZE);
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  if (action === "check" || action === "upgrade" || action === "fullupgrade") {
    rows.push([{ text: "All", callback_data: `menu:runall:${action}` }]);
  }
  rows.push(...pageItems.map((system) => [{
    text: `#${system.id} ${system.name}`,
    callback_data: `menu:run:${action}:${system.id}:${safePage}`,
  }]));

  const navRow: Array<{ text: string; callback_data: string }> = [];
  if (safePage > 0) {
    navRow.push({ text: "Prev", callback_data: `menu:list:${action}:${safePage - 1}` });
  }
  navRow.push({ text: pageLabel(systemsList.length, MENU_PAGE_SIZE, safePage), callback_data: "menu:noop" });
  if (start + MENU_PAGE_SIZE < systemsList.length) {
    navRow.push({ text: "Next", callback_data: `menu:list:${action}:${safePage + 1}` });
  }
  rows.push(navRow);
  rows.push([{ text: "Back", callback_data: "menu:root" }]);

  return { inline_keyboard: rows };
}

function buildPackageMenuKeyboard(systemId: number, packages: string[], page = 0, systemPage = 0) {
  const safePage = clampPage(page, packages.length, PACKAGE_MENU_PAGE_SIZE);
  const start = safePage * PACKAGE_MENU_PAGE_SIZE;
  const pageItems = packages.slice(start, start + PACKAGE_MENU_PAGE_SIZE);
  const rows = pageItems.map((packageName) => [{
    text: packageName,
    callback_data: `menu:pkg:${systemId}:${systemPage}:${encodeURIComponent(packageName)}`,
  }]);

  const navRow: Array<{ text: string; callback_data: string }> = [];
  if (safePage > 0) {
    navRow.push({ text: "Prev", callback_data: `menu:pkgpage:${systemId}:${safePage - 1}:${systemPage}` });
  }
  navRow.push({ text: pageLabel(packages.length, PACKAGE_MENU_PAGE_SIZE, safePage), callback_data: "menu:noop" });
  if (start + PACKAGE_MENU_PAGE_SIZE < packages.length) {
    navRow.push({ text: "Next", callback_data: `menu:pkgpage:${systemId}:${safePage + 1}:${systemPage}` });
  }
  rows.push(navRow);
  rows.push([{ text: "Back", callback_data: `menu:list:pkgsys:${systemPage}` }]);

  return { inline_keyboard: rows };
}

function buildPackageUpdatesKeyboard(systemPage = 0) {
  return {
    inline_keyboard: [[
      { text: "Back", callback_data: `menu:list:pkglist:${systemPage}` },
      { text: "Menu", callback_data: "menu:root" },
    ]],
  };
}

function buildPackageUpdatesMessage(system: Pick<AllowedSystem, "id" | "name">, updates: SystemUpdate[]): string {
  const visibleUpdates = updates.slice(0, 40);
  const extraCount = updates.length - visibleUpdates.length;
  return [
    `Package updates for ${system.name} (#${system.id}): ${formatCount(updates.length, "package")}`,
    ...visibleUpdates.map((update) => formatPackageUpdateEntry(update)),
    extraCount > 0 ? `…and ${extraCount} more packages.` : "",
  ].filter(Boolean).join("\n");
}

function buildRootMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Status", callback_data: "menu:status" },
        { text: "Refresh", callback_data: "menu:list:check:0" },
      ],
      [
        { text: "Upgrade", callback_data: "menu:list:upgrade:0" },
        { text: "Full upgrade", callback_data: "menu:list:fullupgrade:0" },
      ],
      [
        { text: "Upgrade package", callback_data: "menu:list:pkgsys:0" },
        { text: "Show packages", callback_data: "menu:list:pkglist:0" },
      ],
    ],
  };
}

async function sendMenuRoot(botToken: string, chatId: string): Promise<void> {
  await sendTelegramText(
    botToken,
    chatId,
    "Telegram command menu\nChoose an action. Mutating actions still require confirmation.",
    buildRootMenuKeyboard(),
  );
}

async function sendStatus(botToken: string, chatId: string, channel: NotificationRow): Promise<void> {
  const allowedSystems = await fetchAllowedSystems(channel);
  if (allowedSystems.length === 0) {
    await sendTelegramText(botToken, chatId, "No systems are available for this Telegram command channel.");
    return;
  }

  const visibleSystems = allowedSystems.slice(0, 25);
  const pendingUpdateSystems = allowedSystems.filter((system) => Number(system.updateCount ?? 0) > 0).length;
  const totalSecurityUpdates = allowedSystems.reduce((sum, system) => sum + Number(system.securityCount ?? 0), 0);
  const summaryIcon = totalSecurityUpdates > 0 ? "⚠️" : "📦";
  const summaryText = totalSecurityUpdates > 0
    ? `Pending updates on ${formatCount(pendingUpdateSystems, "system")} (${totalSecurityUpdates} security)`
    : `Pending updates on ${formatCount(pendingUpdateSystems, "system")}`;
  const lines = visibleSystems.map((system) =>
    `<code>#${system.id}</code> ${formatReachabilityDot(system.isReachable)} <b>${escapeTelegramHtml(system.name)}</b>: ${escapeTelegramHtml(formatUpdateCounts(Number(system.updateCount ?? 0), Number(system.securityCount ?? 0)))}`
  );
  const suffix = allowedSystems.length > visibleSystems.length
    ? `\n\n<i>...and ${allowedSystems.length - visibleSystems.length} more systems.</i>`
    : "";
  await sendTelegramHtml(
    botToken,
    chatId,
    `${summaryIcon} ${escapeTelegramHtml(summaryText)}\n\n${lines.join("\n")}${suffix}`
  );
}

async function executeCommandForSystem(
  botToken: string,
  chatId: string,
  channel: NotificationRow,
  action: BulkAction,
  system: AllowedSystem,
): Promise<void> {
  const commandToken = resolveTelegramCommandToken(parseConfig(channel.config));
  if (!commandToken) {
    await sendTelegramText(botToken, chatId, "Command token is not ready for this Telegram channel.");
    return;
  }

  if (action === "check") {
    try {
      await startAsyncCommand(
        botToken,
        chatId,
        commandToken,
        `/api/systems/${system.id}/check`,
        `Refreshing updates for ${system.name} (#${system.id})…`,
        (result) => `Refresh completed for ${system.name} (#${system.id}): ${result.updateCount ?? 0} updates available.`,
        buildRefreshFailureMessage(system),
      );
    } catch {
      await sendTelegramText(botToken, chatId, buildRefreshFailureMessage(system));
    }
    return;
  }

  if (action === "fullupgrade" && !system.supportsFullUpgrade) {
    await sendTelegramText(botToken, chatId, `Full upgrade is not supported for ${system.name} (#${system.id}).`);
    return;
  }

  const confirmationToken = createConfirmation({
    notificationId: channel.id,
    chatId,
    botToken,
    actorUserId: 0,
    command: action === "upgrade" ? "upgrade" : "full-upgrade",
    systemId: system.id,
  });
  const prompt = action === "upgrade"
    ? `Confirm upgrade for ${system.name} (#${system.id})?`
    : `Confirm full upgrade for ${system.name} (#${system.id})?`;

  await sendTelegramText(botToken, chatId, prompt, buildConfirmationKeyboard(confirmationToken));
}

async function promptPackageSelection(
  botToken: string,
  chatId: string,
  channel: NotificationRow,
  system: AllowedSystem,
  page = 0,
  systemPage = 0,
): Promise<void> {
  const packages = await fetchPackageNames(channel, system.id);

  if (packages.length === 0) {
    await sendTelegramText(botToken, chatId, `No upgradable packages are currently cached for ${system.name} (#${system.id}).`);
    return;
  }

  await sendTelegramText(
    botToken,
    chatId,
    `Select a package to upgrade on ${system.name} (#${system.id}). ${pageLabel(packages.length, PACKAGE_MENU_PAGE_SIZE, page)}`,
    buildPackageMenuKeyboard(system.id, packages, page, systemPage),
  );
}

async function sendPackageUpdates(
  botToken: string,
  chatId: string,
  channel: NotificationRow,
  system: AllowedSystem,
  systemPage?: number,
): Promise<void> {
  const updates = await fetchSystemUpdates(channel, system.id);

  if (updates.length === 0) {
    await sendTelegramText(botToken, chatId, `No cached package updates are currently available for ${system.name} (#${system.id}).`);
    return;
  }

  await sendTelegramText(
    botToken,
    chatId,
    buildPackageUpdatesMessage(system, updates),
    typeof systemPage === "number" ? buildPackageUpdatesKeyboard(systemPage) : undefined,
  );
}

async function promptSystemSelection(
  botToken: string,
  chatId: string,
  channel: NotificationRow,
  action: SystemAction,
  page = 0,
): Promise<void> {
  const allowedSystems = await getSystemsForAction(channel, action);
  if (allowedSystems.length === 0) {
    await sendTelegramText(botToken, chatId, noSystemsMessage(action));
    return;
  }

  const title = action === "check"
    ? "Select a system to refresh:"
    : action === "upgrade"
      ? "Select a system to upgrade:"
      : action === "fullupgrade"
        ? "Select a system for full upgrade:"
        : action === "pkglist"
          ? "Select a system to view package updates:"
          : "Select a system to choose a package:";
  await sendTelegramText(
    botToken,
    chatId,
    `${title} ${pageLabel(allowedSystems.length, MENU_PAGE_SIZE, page)}`,
    buildSystemMenuKeyboard(action, allowedSystems, page),
  );
}

function createConfirmation(pending: Omit<PendingConfirmation, "expiresAt">): string {
  const token = crypto.randomUUID();
  pendingConfirmations.set(token, {
    ...pending,
    expiresAt: Date.now() + CONFIRM_TTL_MS,
  });
  return token;
}

async function awaitJobResult(
  commandToken: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < JOB_POLL_ATTEMPTS; attempt += 1) {
    const job = await callDashboardApi<{ status: string; result?: Record<string, unknown> }>(
      commandToken,
      `/api/jobs/${jobId}`
    );
    if (job.status === "done") {
      return job.result || {};
    }
    if (job.status === "failed") {
      throw new Error(sanitizeOutput(String(job.result?.error || "Job failed")));
    }
    await sleep(JOB_POLL_INTERVAL_MS);
  }

  throw new Error("Command timed out while waiting for completion.");
}

async function executeBulkCommand(
  botToken: string,
  chatId: string,
  commandToken: string,
  action: BulkAction,
  systems: Array<{ id: number; name: string }>,
): Promise<void> {
  const pathBuilder = (systemId: number) =>
    action === "check"
      ? `/api/systems/${systemId}/check`
      : action === "upgrade"
        ? `/api/systems/${systemId}/upgrade`
        : `/api/systems/${systemId}/full-upgrade`;

  const startResults = await Promise.all(systems.map(async (system) => {
    try {
      const response = await callDashboardApi<{ status: string; jobId: string }>(
        commandToken,
        pathBuilder(system.id),
        { method: "POST" },
      );
      return { system, jobId: response.jobId } as const;
    } catch (error) {
      if (isCommandTokenAuthError(error)) throw error;
      return { system, startError: error } as const;
    }
  }));

  const startedJobs = startResults.filter((result): result is { system: { id: number; name: string }; jobId: string } => "jobId" in result);
  const startFailures = startResults.filter((result): result is { system: { id: number; name: string }; startError: unknown } => "startError" in result);

  if (startedJobs.length === 0) {
    const failureLines = startFailures.map(({ system, startError }) =>
      action === "check"
        ? `- ${formatSystemLabel(system)}: failed`
        : `- ${formatSystemLabel(system)}: ${sanitizeOutput(startError instanceof Error ? startError.message : String(startError))}`
    );
    await sendTelegramText(
      botToken,
      chatId,
      buildBulkSummaryMessage(action, systems.length, failureLines, 0, 0, startFailures.length),
    );
    return;
  }

  await sendTelegramText(botToken, chatId, buildBulkStartedMessage(action, startedJobs.length, startFailures.length));

  void (async () => {
    const jobResults = await Promise.all(startedJobs.map(async ({ system, jobId }) => {
      try {
        const result = await awaitJobResult(commandToken, jobId);
        return { system, result } as const;
      } catch (error) {
        return { system, error } as const;
      }
    }));

    let successCount = 0;
    let warningCount = 0;
    let failedCount = startFailures.length;
    const lines: string[] = startFailures.map(({ system, startError }) =>
      action === "check"
        ? `- ${formatSystemLabel(system)}: failed`
        : `- ${formatSystemLabel(system)}: failed to start (${sanitizeOutput(startError instanceof Error ? startError.message : String(startError))})`
    );

    for (const entry of jobResults) {
      if ("error" in entry) {
        if (isCommandTokenAuthError(entry.error)) {
          await sendTelegramText(botToken, chatId, COMMAND_TOKEN_AUTH_FAILURE_MESSAGE);
          return;
        }
        failedCount += 1;
        lines.push(
          action === "check"
            ? `- ${formatSystemLabel(entry.system)}: failed`
            : `- ${formatSystemLabel(entry.system)}: failed (${sanitizeOutput(entry.error instanceof Error ? entry.error.message : String(entry.error))})`
        );
        continue;
      }

      if (action === "check") {
        successCount += 1;
        lines.push(`- ${formatSystemLabel(entry.system)}: ${Number(entry.result.updateCount ?? 0)} updates`);
        continue;
      }

      const status = sanitizeOutput(String(entry.result.status || "unknown")).toLowerCase();
      if (status === "warning") {
        warningCount += 1;
      } else if (status === "success") {
        successCount += 1;
      } else {
        failedCount += 1;
      }
      lines.push(`- ${formatSystemLabel(entry.system)}: ${status}`);
    }

    await sendTelegramText(
      botToken,
      chatId,
      buildBulkSummaryMessage(action, systems.length, lines, successCount, warningCount, failedCount),
    );
  })().catch(async (error) => {
    await sendCommandExecutionError(botToken, chatId, error);
  });
}

async function promptBulkConfirmation(
  botToken: string,
  chatId: string,
  channel: NotificationRow,
  action: Exclude<BulkAction, "check">,
): Promise<void> {
  const systems = await getSystemsForAction(channel, action);
  if (systems.length === 0) {
    await sendTelegramText(botToken, chatId, noSystemsMessage(action));
    return;
  }

  const confirmationToken = createConfirmation({
    notificationId: channel.id,
    chatId,
    botToken,
    actorUserId: 0,
    command: action === "upgrade" ? "upgrade-all" : "full-upgrade-all",
    targetSystems: systems.map((system) => ({ id: system.id, name: system.name })),
  });
  await sendTelegramText(
    botToken,
    chatId,
    buildBulkConfirmationPrompt(action, systems),
    buildConfirmationKeyboard(confirmationToken),
  );
}

async function pollJobAndReport(
  botToken: string,
  chatId: string,
  commandToken: string,
  jobId: string,
  summaryBuilder: (result: Record<string, unknown>) => string,
  failureMessage?: string,
): Promise<void> {
  try {
    const result = await awaitJobResult(commandToken, jobId);
    await sendTelegramText(botToken, chatId, summaryBuilder(result));
  } catch (error) {
    if (isCommandTokenAuthError(error)) {
      await sendTelegramText(botToken, chatId, COMMAND_TOKEN_AUTH_FAILURE_MESSAGE);
    } else {
      if (failureMessage) {
        await sendTelegramText(botToken, chatId, failureMessage);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await sendTelegramText(botToken, chatId, `Command failed: ${sanitizeOutput(truncateMessage(message))}`);
      }
    }
  }
}

async function startAsyncCommand(
  botToken: string,
  chatId: string,
  commandToken: string,
  path: string,
  startedMessage: string,
  summaryBuilder: (result: Record<string, unknown>) => string,
  failureMessage?: string,
): Promise<void> {
  const response = await callDashboardApi<{ status: string; jobId: string }>(commandToken, path, {
    method: "POST",
  });
  await sendTelegramText(botToken, chatId, startedMessage);
  void pollJobAndReport(botToken, chatId, commandToken, response.jobId, summaryBuilder, failureMessage);
}

async function handleCommandMessage(
  botToken: string,
  chatId: string,
  message: TelegramMessage,
): Promise<void> {
  const parsed = parseCommand(message.text || "");
  if (!parsed) return;

  if (parsed.command === "help" || parsed.command === "start") {
    if (parsed.command === "start" && parsed.args[0]) {
      await handleLinkStart(botToken, chatId, parsed.args[0], { message });
      return;
    }
    await sendTelegramText(botToken, chatId, helpText());
    return;
  }

  const channel = await findCommandChannel(botToken, chatId);
  if (!channel) {
    await sendTelegramText(
      botToken,
      chatId,
      "Commands are not enabled for this chat. Bind a Telegram notification channel and enable commands in the UI first."
    );
    return;
  }

  const commandToken = resolveTelegramCommandToken(parseConfig(channel.config));
  if (!commandToken) {
    await sendTelegramText(botToken, chatId, "Command token is not ready for this Telegram channel.");
    return;
  }

  try {
    if (parsed.command === "status") {
      await sendStatus(botToken, chatId, channel);
      return;
    }

    if (parsed.command === "menu") {
      await sendMenuRoot(botToken, chatId);
      return;
    }

    const requestedCommand = parsed.command === "refresh" ? "check" : parsed.command;

    if ((requestedCommand === "check" || requestedCommand === "upgrade" || requestedCommand === "fullupgrade") && parsed.args[0]?.toLowerCase() === "all") {
      if (requestedCommand === "check") {
        const systems = await getSystemsForAction(channel, "check");
        if (systems.length === 0) {
          await sendTelegramText(botToken, chatId, noSystemsMessage("check"));
          return;
        }
        await executeBulkCommand(
          botToken,
          chatId,
          commandToken,
          "check",
          systems.map((system) => ({ id: system.id, name: system.name })),
        );
        return;
      }

      await promptBulkConfirmation(
        botToken,
        chatId,
        channel,
        requestedCommand === "upgrade" ? "upgrade" : "fullupgrade",
      );
      return;
    }

    if (requestedCommand === "packages" && !parsed.args[0]) {
      await sendTelegramText(botToken, chatId, "Usage: /packages <system-id>");
      return;
    }

    const allowedSystems = await fetchAllowedSystems(channel);
    const system = resolveSystem(allowedSystems, parsed.args[0]);
    if (!system) {
      await sendTelegramText(botToken, chatId, "Unknown or unauthorized system. Use /status to list allowed system IDs.");
      return;
    }

    if (requestedCommand === "packages") {
      await sendPackageUpdates(botToken, chatId, channel, system);
      return;
    }

    if (requestedCommand === "check") {
      await executeCommandForSystem(botToken, chatId, channel, "check", system);
      return;
    }

    let confirmationToken = "";
    let prompt = "";

    if (requestedCommand === "upgrade") {
      confirmationToken = createConfirmation({
        notificationId: channel.id,
        chatId,
        botToken,
        actorUserId: 0,
        command: "upgrade",
        systemId: system.id,
      });
      prompt = `Confirm upgrade for ${system.name} (#${system.id})?`;
    } else if (requestedCommand === "fullupgrade") {
      if (!system.supportsFullUpgrade) {
        await sendTelegramText(botToken, chatId, `Full upgrade is not supported for ${system.name} (#${system.id}).`);
        return;
      }
      confirmationToken = createConfirmation({
        notificationId: channel.id,
        chatId,
        botToken,
        actorUserId: 0,
        command: "full-upgrade",
        systemId: system.id,
      });
      prompt = `Confirm full upgrade for ${system.name} (#${system.id})?`;
    } else if (requestedCommand === "upgradepkg") {
      const packageName = parsed.args[1];
      if (!packageName) {
        await sendTelegramText(botToken, chatId, "Usage: /upgradepkg <system-id> <package>");
        return;
      }
      confirmationToken = createConfirmation({
        notificationId: channel.id,
        chatId,
        botToken,
        actorUserId: 0,
        command: "upgrade-package",
        systemId: system.id,
        packageName,
      });
      prompt = `Confirm package upgrade on ${system.name} (#${system.id}) for ${packageName}?`;
    } else {
      await sendTelegramText(botToken, chatId, helpText());
      return;
    }

    await sendTelegramText(botToken, chatId, prompt, {
      ...buildConfirmationKeyboard(confirmationToken),
    });
  } catch (error) {
    await sendCommandExecutionError(botToken, chatId, error);
  }
}

async function handleCallbackQuery(botToken: string, callback: TelegramCallbackQuery): Promise<void> {
  const callbackId = callback.id;
  const chat = callback.message?.chat;
  const chatId = chat?.id === undefined || chat?.id === null ? null : String(chat.id);
  if (!callbackId || !chatId || !callback.data) return;

  if (callback.data.startsWith("menu:")) {
    const channel = await findCommandChannel(botToken, chatId);
    if (!channel) {
      await answerCallback(botToken, callbackId, "Commands are not enabled for this chat.");
      return;
    }

    const parts = callback.data.split(":");
    const menuAction = parts[1];
    await answerCallback(botToken, callbackId);

    try {
      if (menuAction === "root") {
        await sendMenuRoot(botToken, chatId);
        return;
      }

      if (menuAction === "noop") {
        return;
      }

      if (menuAction === "status") {
        await sendStatus(botToken, chatId, channel);
        return;
      }

      if (menuAction === "list") {
        const action = parts[2];
        const page = Number.parseInt(parts[3] || "0", 10) || 0;
        if (action === "check" || action === "upgrade" || action === "fullupgrade" || action === "pkgsys" || action === "pkglist") {
          await promptSystemSelection(botToken, chatId, channel, action, page);
        }
        return;
      }

      if (menuAction === "runall") {
        const action = parts[2];
        if (action === "check") {
          const commandToken = resolveTelegramCommandToken(parseConfig(channel.config));
          if (!commandToken) {
            await sendTelegramText(botToken, chatId, "Command token is not ready for this Telegram channel.");
            return;
          }
          const systems = await getSystemsForAction(channel, "check");
          if (systems.length === 0) {
            await sendTelegramText(botToken, chatId, noSystemsMessage("check"));
            return;
          }
          await executeBulkCommand(
            botToken,
            chatId,
            commandToken,
            "check",
            systems.map((system) => ({ id: system.id, name: system.name })),
          );
          return;
        }

        if (action === "upgrade" || action === "fullupgrade") {
          await promptBulkConfirmation(botToken, chatId, channel, action);
        }
        return;
      }

      if (menuAction === "run") {
        const action = parts[2];
        const systemId = Number.parseInt(parts[3] || "", 10);
        const sourcePage = Number.parseInt(parts[4] || "0", 10) || 0;
        const allowedSystems = await fetchAllowedSystems(channel);
        const system = allowedSystems.find((entry) => entry.id === systemId);
        if (!system) {
          await sendTelegramText(botToken, chatId, "Unknown or unauthorized system.");
          return;
        }

        if (action === "pkgsys") {
          await promptPackageSelection(botToken, chatId, channel, system, 0, sourcePage);
          return;
        }

        if (action === "pkglist") {
          await sendPackageUpdates(botToken, chatId, channel, system, sourcePage);
          return;
        }

        if (action === "check" || action === "upgrade" || action === "fullupgrade") {
          await executeCommandForSystem(botToken, chatId, channel, action, system);
        }
        return;
      }

      if (menuAction === "pkgpage") {
        const systemId = Number.parseInt(parts[2] || "", 10);
        const page = Number.parseInt(parts[3] || "0", 10) || 0;
        const sourcePage = Number.parseInt(parts[4] || "0", 10) || 0;
        const allowedSystems = await fetchAllowedSystems(channel);
        const system = allowedSystems.find((entry) => entry.id === systemId);
        if (!system) {
          await sendTelegramText(botToken, chatId, "Unknown or unauthorized system.");
          return;
        }
        await promptPackageSelection(botToken, chatId, channel, system, page, sourcePage);
        return;
      }

      if (menuAction === "pkg") {
        const systemId = Number.parseInt(parts[2] || "", 10);
        const encodedPackage = parts.slice(4).join(":");
        const packageName = decodeURIComponent(encodedPackage || "");
        const allowedSystems = await fetchAllowedSystems(channel);
        const system = allowedSystems.find((entry) => entry.id === systemId);
        if (!system || !packageName) {
          await sendTelegramText(botToken, chatId, "Unknown system or package.");
          return;
        }

        const confirmationToken = createConfirmation({
          notificationId: channel.id,
          chatId,
          botToken,
          actorUserId: 0,
          command: "upgrade-package",
          systemId: system.id,
          packageName,
        });
        await sendTelegramText(
          botToken,
          chatId,
          `Confirm package upgrade on ${system.name} (#${system.id}) for ${packageName}?`,
          buildConfirmationKeyboard(confirmationToken),
        );
        return;
      }

      return;
    } catch (error) {
      await sendCommandExecutionError(botToken, chatId, error);
      return;
    }
  }

  const [action, token] = callback.data.split(":");
  const pending = pendingConfirmations.get(token);
  if (!pending || pending.expiresAt <= Date.now() || pending.botToken !== botToken || pending.chatId !== chatId) {
    pendingConfirmations.delete(token);
    await answerCallback(botToken, callbackId, "This confirmation expired.");
    return;
  }

  if (action === "cancel") {
    pendingConfirmations.delete(token);
    await answerCallback(botToken, callbackId, "Cancelled.");
    await sendTelegramText(botToken, chatId, "Command cancelled.");
    return;
  }

  if (action !== "confirm") {
    await answerCallback(botToken, callbackId, "Unsupported action.");
    return;
  }

  pendingConfirmations.delete(token);
  await answerCallback(botToken, callbackId, "Executing command.");

  const row = getDb().select().from(notifications).where(eq(notifications.id, pending.notificationId)).get();
  if (!row || row.enabled !== 1) {
    await sendTelegramText(botToken, chatId, "This Telegram notification channel is no longer available.");
    return;
  }

  const commandToken = resolveTelegramCommandToken(parseConfig(row.config));
  if (!commandToken) {
    await sendTelegramText(botToken, chatId, "Command token is no longer available.");
    return;
  }

  try {
    const authorized = await revalidatePendingConfirmation(row, pending);
    if (!authorized.ok) {
      await sendTelegramText(botToken, chatId, authorized.message);
      return;
    }

    if (pending.command === "upgrade") {
      await startAsyncCommand(
        botToken,
        chatId,
        commandToken,
        `/api/systems/${authorized.systemId}/upgrade`,
        `Upgrade started for system #${authorized.systemId}.`,
        (result) => `Upgrade finished for system #${authorized.systemId}: ${sanitizeOutput(String(result.status || "unknown"))}\n${truncateMessage(sanitizeOutput(String(result.output || "")))}`,
      );
      return;
    }

    if (pending.command === "full-upgrade") {
      await startAsyncCommand(
        botToken,
        chatId,
        commandToken,
        `/api/systems/${authorized.systemId}/full-upgrade`,
        `Full upgrade started for system #${authorized.systemId}.`,
        (result) => `Full upgrade finished for system #${authorized.systemId}: ${sanitizeOutput(String(result.status || "unknown"))}\n${truncateMessage(sanitizeOutput(String(result.output || "")))}`,
      );
      return;
    }

    if (pending.command === "upgrade-all" && authorized.targetSystems?.length) {
      await executeBulkCommand(botToken, chatId, commandToken, "upgrade", authorized.targetSystems);
      return;
    }

    if (pending.command === "full-upgrade-all" && authorized.targetSystems?.length) {
      await executeBulkCommand(botToken, chatId, commandToken, "fullupgrade", authorized.targetSystems);
      return;
    }

    if (pending.command === "upgrade-package" && pending.packageName) {
      await startAsyncCommand(
        botToken,
        chatId,
        commandToken,
        `/api/systems/${authorized.systemId}/upgrade/${encodeURIComponent(pending.packageName)}`,
        `Package upgrade started for ${pending.packageName} on system #${authorized.systemId}.`,
        (result) => `Package upgrade finished for ${sanitizeOutput(String(result.package || pending.packageName))} on system #${authorized.systemId}: ${sanitizeOutput(String(result.status || "unknown"))}\n${truncateMessage(sanitizeOutput(String(result.output || "")))}`,
      );
    }
  } catch (error) {
    await sendCommandExecutionError(botToken, chatId, error);
  }
}

async function processUpdate(botToken: string, update: TelegramUpdate): Promise<void> {
  cleanupExpiringState();

  if (update.callback_query) {
    const chatId = privateChatIdFrom(update);
    if (!chatId) return;
    await handleCallbackQuery(botToken, update.callback_query);
    return;
  }

  const message = update.message;
  const chatId = privateChatIdFrom(update);
  if (!message || !chatId || !message.text) return;

  await handleCommandMessage(botToken, chatId, message);
}

async function runWorker(botToken: string, state: WorkerState): Promise<void> {
  while (!state.stop) {
    try {
      const res = await telegramApi(botToken, "getUpdates", {
        offset: state.offset,
        timeout: POLL_TIMEOUT_SECONDS,
        allowed_updates: ["message", "callback_query"],
      });
      const body = await res.json().catch(() => null) as { ok?: boolean; result?: TelegramUpdate[]; description?: string } | null;
      if (!res.ok || !body?.ok || !Array.isArray(body.result)) {
        throw new Error(body?.description || `Telegram getUpdates failed (${res.status})`);
      }

      for (const update of body.result) {
        if (typeof update.update_id === "number") {
          state.offset = update.update_id + 1;
        }
        await processUpdate(botToken, update);
      }
    } catch (error) {
      logger.error("Telegram polling failed", { error: String(error) });
      await sleep(5_000);
    }
  }
}

export async function sync(): Promise<void> {
  if (!started) return;

  const activeTokens = new Set<string>();
  for (const row of getTelegramRows()) {
    if (row.enabled !== 1) continue;
    const token = resolveTelegramBotToken(parseConfig(row.config));
    if (token) activeTokens.add(token);
  }

  for (const [token] of workers) {
    if (!activeTokens.has(token)) {
      stopWorker(token);
    }
  }

  for (const token of activeTokens) {
    try {
      await syncBotCommands(token);
    } catch (error) {
      logger.error("Telegram command menu sync failed", { error: String(error) });
    }
    if (workers.has(token)) continue;
    const state: WorkerState = { stop: false, offset: 0 };
    workers.set(token, state);
    void runWorker(token, state);
  }
}

export async function start(): Promise<void> {
  started = true;
  await sync();
}

export function stop(): void {
  started = false;
  for (const [token] of workers) {
    stopWorker(token);
  }
}

export async function reconcileNotificationChange(
  previousRow: NotificationRow | null,
  currentRow: NotificationRow | null,
  actorUserId?: number,
): Promise<void> {
  if (previousRow?.type === TELEGRAM_TYPE && (!currentRow || currentRow.type !== TELEGRAM_TYPE)) {
    await revokeCommandToken(loadTelegramConfig(previousRow));
  }

  if (currentRow?.type === TELEGRAM_TYPE) {
    const previousConfig = previousRow?.type === TELEGRAM_TYPE ? loadTelegramConfig(previousRow) : null;
    const currentConfig = loadTelegramConfig(currentRow);
    await reconcileTelegramConfig(currentRow.id, previousConfig, currentConfig, actorUserId);
  }

  await sync();
}

export async function createBindingLink(notificationId: number, actorUserId: number): Promise<{ url: string; expiresAt: string }> {
  const row = getDb().select().from(notifications).where(eq(notifications.id, notificationId)).get();
  if (!row || row.type !== TELEGRAM_TYPE) {
    throw new Error("Telegram notification not found");
  }

  const currentConfig = loadTelegramConfig(row);
  const botToken = resolveTelegramBotToken(currentConfig as unknown as Record<string, unknown>);
  if (!botToken) {
    throw new Error("Telegram bot token must be configured before linking a chat");
  }

  await syncBotProfilePhoto(botToken);
  const botUsername = await getBotUsername(botToken);
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = Date.now() + LINK_TTL_MS;
  linkRequests.set(nonce, {
    notificationId,
    botToken,
    actorUserId,
    expiresAt,
  });

  const nextConfig: TelegramConfig = {
    ...currentConfig,
    botUsername,
    chatBindingStatus: "pending",
  };
  writeTelegramConfig(notificationId, nextConfig);

  return {
    url: `https://t.me/${botUsername}?start=${nonce}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export async function unlinkNotification(notificationId: number): Promise<void> {
  const row = getDb().select().from(notifications).where(eq(notifications.id, notificationId)).get();
  if (!row || row.type !== TELEGRAM_TYPE) {
    throw new Error("Telegram notification not found");
  }

  const currentConfig = loadTelegramConfig(row);
  await revokeCommandToken(currentConfig);
  const nextConfig: TelegramConfig = {
    ...currentConfig,
    chatId: undefined,
    chatDisplayName: undefined,
    chatBoundAt: undefined,
    chatBindingStatus: "unbound",
    commandApiTokenEncrypted: undefined,
    commandApiTokenId: undefined,
  };
  writeTelegramConfig(notificationId, nextConfig);
  await sync();
}

export async function reissueCommandToken(notificationId: number, actorUserId: number): Promise<void> {
  const row = getDb().select().from(notifications).where(eq(notifications.id, notificationId)).get();
  if (!row || row.type !== TELEGRAM_TYPE) {
    throw new Error("Telegram notification not found");
  }

  const currentConfig = loadTelegramConfig(row);
  if (!currentConfig.commandsEnabled) {
    throw new Error("Telegram bot commands are disabled for this notification");
  }
  if (!currentConfig.chatId) {
    throw new Error("Link a private Telegram chat before issuing a command token");
  }
  if (!resolveTelegramBotToken(currentConfig as unknown as Record<string, unknown>)) {
    throw new Error("Configure a Telegram bot token before issuing a command token");
  }

  await revokeCommandToken(currentConfig);
  const nextConfig = await ensureCommandToken(notificationId, actorUserId, {
    ...currentConfig,
    commandApiTokenEncrypted: undefined,
    commandApiTokenId: undefined,
  });
  writeTelegramConfig(notificationId, nextConfig);
}

function resetTestingState(): void {
  stop();
  linkRequests.clear();
  pendingConfirmations.clear();
  syncedProfilePhotos.clear();
  botProfilePhotoPath = undefined;
}

export const __testing = {
  processUpdate,
  resetTestingState,
};
