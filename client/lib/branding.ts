import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { usePublicSettingsResponse, type PublicBranding } from "./settings";

export const DEFAULT_APP_NAME = "Linux Update Dashboard";
export const APP_NAME_SETTING_KEY = "app_name";
export const MAX_APP_NAME_LENGTH = 60;
export const MAX_APP_LOGO_BYTES = 512 * 1024;
export const ACCEPTED_APP_LOGO_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
];

export function useBranding(): PublicBranding {
  const { data } = usePublicSettingsResponse();
  return {
    appName: data?.branding?.appName || DEFAULT_APP_NAME,
    logoUrl: data?.branding?.logoUrl ?? null,
  };
}

/** Keeps the browser tab title and favicon in sync with the configured branding. */
export function useDocumentBranding(): void {
  const { appName, logoUrl } = useBranding();

  useEffect(() => {
    document.title = appName;
  }, [appName]);

  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (!link) return;
    link.dataset.defaultHref ??= link.getAttribute("href") ?? "";
    link.dataset.defaultType ??= link.getAttribute("type") ?? "";

    if (logoUrl) {
      link.removeAttribute("type");
      link.href = logoUrl;
    } else {
      link.href = link.dataset.defaultHref;
      if (link.dataset.defaultType) link.type = link.dataset.defaultType;
    }
  }, [logoUrl]);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

const PROFILE_PHOTO_SIZE = 640;
const PROFILE_PHOTO_PADDING = 0.14;

/**
 * Renders the logo centered on a white square JPEG. Services such as Telegram
 * bot profile photos only accept JPEG, so the browser converts it once here.
 * Returns undefined when the image cannot be rendered.
 */
async function renderProfilePhotoJpeg(dataUrl: string): Promise<string | undefined> {
  try {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = PROFILE_PHOTO_SIZE;
    canvas.height = PROFILE_PHOTO_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return undefined;

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, PROFILE_PHOTO_SIZE, PROFILE_PHOTO_SIZE);
    const available = PROFILE_PHOTO_SIZE * (1 - PROFILE_PHOTO_PADDING * 2);
    const width = image.naturalWidth || 1;
    const height = image.naturalHeight || 1;
    const scale = available / Math.max(width, height);
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    context.drawImage(
      image,
      (PROFILE_PHOTO_SIZE - drawWidth) / 2,
      (PROFILE_PHOTO_SIZE - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    return undefined;
  }
}

type BrandingMutationResponse = { status: string; branding: PublicBranding };

export function useUploadAppLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const dataUrl = await readFileAsDataUrl(file);
      const jpegDataUrl = await renderProfilePhotoJpeg(dataUrl);
      return apiFetch<BrandingMutationResponse>("/settings/branding/logo", {
        method: "PUT",
        body: JSON.stringify({ dataUrl, jpegDataUrl }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export function useResetAppLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<BrandingMutationResponse>("/settings/branding/logo", { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
