export type HostKeyStatus = "verified" | "verification_disabled" | "needs_approval";

const HOST_KEY_STATUS_BADGE_LABELS: Record<HostKeyStatus, string> = {
  verified: "components.hostKeyStatus.approved",
  verification_disabled: "components.hostKeyStatus.verificationOff",
  needs_approval: "components.hostKeyStatus.needsApprovalCompact",
};

const HOST_KEY_STATUS_BADGE_FALLBACKS: Record<HostKeyStatus, string> = {
  verified: "Approved",
  verification_disabled: "Verification off",
  needs_approval: "Needs\u00A0approval",
};

const HOST_KEY_STATUS_TEXT: Record<HostKeyStatus, string> = {
  verified: "components.hostKeyStatus.approved",
  verification_disabled: "components.hostKeyStatus.verificationDisabled",
  needs_approval: "components.hostKeyStatus.needsApproval",
};

const HOST_KEY_STATUS_TEXT_FALLBACKS: Record<HostKeyStatus, string> = {
  verified: "Approved",
  verification_disabled: "Verification disabled",
  needs_approval: "Needs approval",
};

type TranslateHostKeyStatus = (key: string) => string;

export function getHostKeyStatusBadgeLabel(status: HostKeyStatus, t?: TranslateHostKeyStatus): string {
  const key = HOST_KEY_STATUS_BADGE_LABELS[status];
  return t ? t(key) : HOST_KEY_STATUS_BADGE_FALLBACKS[status];
}

export function getHostKeyStatusText(status: HostKeyStatus, t?: TranslateHostKeyStatus): string {
  const key = HOST_KEY_STATUS_TEXT[status];
  return t ? t(key) : HOST_KEY_STATUS_TEXT_FALLBACKS[status];
}
