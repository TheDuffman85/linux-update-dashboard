export type NotificationPriority = "min" | "low" | "default" | "high" | "urgent";
export type NotificationEventType = "updates" | "unreachable" | "appUpdates";
export type NotificationConfig = Record<string, unknown>;

export interface CheckResult {
  systemId: number;
  systemName: string;
  updateCount: number;
  securityCount: number;
  previouslyReachable: boolean;
  nowUnreachable: boolean;
}

export interface AppUpdateEvent {
  currentVersion: string | null;
  currentBranch: string;
  remoteVersion: string;
  releaseUrl: string | null;
  repoUrl: string | null;
}

export interface NotificationEventTotals {
  systemsWithUpdates: number;
  totalUpdates: number;
  totalSecurity: number;
  unreachableSystems: number;
}

export interface NotificationEventData {
  title: string;
  body: string;
  priority: NotificationPriority;
  tags: string[];
  sentAt: string;
  eventTypes: NotificationEventType[];
  totals: NotificationEventTotals;
  updates: CheckResult[];
  unreachable: Array<Pick<CheckResult, "systemId" | "systemName">>;
  appUpdate: AppUpdateEvent | null;
}

export interface NotificationPayload {
  title: string;
  body: string;
  priority?: NotificationPriority;
  tags?: string[];
  event: NotificationEventData;
}

export interface NotificationResult {
  success: boolean;
  error?: string;
  statusCode?: number;
  summary?: string;
}

export interface NotificationProvider {
  name: string;
  sanitizeConfig(config: NotificationConfig): NotificationConfig;
  maskConfig(config: NotificationConfig): NotificationConfig;
  mergeConfig(storedConfig: NotificationConfig, incomingConfig: NotificationConfig): NotificationConfig;
  prepareConfigForStorage(config: NotificationConfig): NotificationConfig;
  validateConfig(config: NotificationConfig): string | null;
  send(
    payload: NotificationPayload,
    config: NotificationConfig
  ): Promise<NotificationResult>;
}
