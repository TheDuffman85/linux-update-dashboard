export interface NotificationPayload {
  title: string;
  body: string;
  priority?: "min" | "low" | "default" | "high" | "urgent";
  tags?: string[];
}

export interface NotificationResult {
  success: boolean;
  error?: string;
}

export interface NotificationProvider {
  name: string;
  send(
    payload: NotificationPayload,
    config: Record<string, string>
  ): Promise<NotificationResult>;
  validateConfig(config: Record<string, string>): string | null;
}
