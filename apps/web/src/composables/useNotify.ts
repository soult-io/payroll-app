/**
 * Toast + error normalization (UX conventions: every mutation gets feedback).
 */

import { useToast } from "primevue/usetoast";
import { ApiError } from "../lib/api";

export function useNotify() {
  const toast = useToast();

  function success(summary: string, detail?: string) {
    toast.add({ severity: "success", summary, detail, life: 3500 });
  }

  function info(summary: string, detail?: string) {
    toast.add({ severity: "info", summary, detail, life: 4000 });
  }

  /** Human message out of ApiError / Error / unknown. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: error-code mapping chain; a lookup table would hide ApiError precedence
  function errorMessage(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.status === 401) return "Your session expired — sign in again.";
      if (err.status === 403) return "You do not have access to that.";
      if (err.status === 404) return "Not found.";
      if (err.code === "duplicate_pending") return "A pending request of this type already exists.";
      if (err.code === "effective_date") return err.message;
      return err.message;
    }
    if (err instanceof Error) return err.message;
    return "Something went wrong.";
  }

  function error(err: unknown, summary = "Error") {
    toast.add({ severity: "error", summary, detail: errorMessage(err), life: 5000 });
  }

  return { success, info, error, errorMessage };
}
