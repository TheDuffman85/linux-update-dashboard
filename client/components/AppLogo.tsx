import { useState } from "react";
import { useBranding } from "../lib/branding";
import { PenguinLogo } from "./PenguinLogo";

export function AppLogo({ size = 32 }: { size?: number }) {
  const { logoUrl } = useBranding();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (!logoUrl || failedUrl === logoUrl) {
    return <PenguinLogo size={size} />;
  }

  return (
    <img
      src={logoUrl}
      alt=""
      width={size}
      height={size}
      className="shrink-0 object-contain"
      style={{ width: size, height: size }}
      onError={() => setFailedUrl(logoUrl)}
    />
  );
}
