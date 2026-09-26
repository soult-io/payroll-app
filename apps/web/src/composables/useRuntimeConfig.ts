/**
 * Public runtime config (spec 14 + spec 22 D2): the deployment environment
 * label and the product name, from the unauthenticated GET
 * /api/runtime-config. Fetched once per page load and shared by every
 * caller (App shell, login card).
 *
 * The brand name starts as DEFAULT_BRAND_NAME and keeps it if the fetch
 * fails, so a default deployment never shows a different name first. The
 * tab title follows the resolved name.
 */

import { ref } from "vue";
import { DEFAULT_BRAND_NAME } from "@payroll/shared";

const appEnv = ref("");
const brandName = ref(DEFAULT_BRAND_NAME);
let loaded: Promise<void> | null = null;

async function load(): Promise<void> {
  try {
    const res = await fetch("/api/runtime-config");
    if (!res.ok) return;
    const body = (await res.json()) as { appEnv?: unknown; brandName?: unknown };
    if (typeof body.appEnv === "string") appEnv.value = body.appEnv;
    if (typeof body.brandName === "string" && body.brandName.trim() !== "") {
      brandName.value = body.brandName;
    }
  } catch {
    // Best-effort: the banner and the name never block the app.
  } finally {
    document.title = brandName.value;
  }
}

export function useRuntimeConfig() {
  loaded ??= load();
  return { appEnv, brandName, loaded };
}
