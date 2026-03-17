export type HostKeyStatus = "verified" | "verification_disabled" | "needs_approval";

const HOST_KEY_STATUS_BADGE_LABELS: Record<HostKeyStatus, string> = {
  verified: "Approved",
  verification_disabled: "Verification off",
  needs_approval: "Needs\u00A0approval",
};

const HOST_KEY_STATUS_TEXT: Record<HostKeyStatus, string> = {
  verified: "Approved",
  verification_disabled: "Verification disabled",
  needs_approval: "Needs approval",
};

export function getHostKeyStatusBadgeLabel(status: HostKeyStatus): string {
  return HOST_KEY_STATUS_BADGE_LABELS[status];
}

export function getHostKeyStatusText(status: HostKeyStatus): string {
  return HOST_KEY_STATUS_TEXT[status];
}
