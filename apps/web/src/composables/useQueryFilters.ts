/**
 * PAY-17: list filter state lives in the route query (?year=2025&status=ready)
 * instead of local refs. The URL is the single source of truth, so filters are
 * bookmarkable, survive browser-back for free, and let detail pages return to
 * the exact filtered list the user came from (BackButton passes the detail's
 * query back to the list route). Filter changes use router.replace so they
 * don't spam the history stack.
 */
import { computed, type WritableComputedRef } from "vue";
import { useRoute, useRouter } from "vue-router";

/** Bind one filter value to a route query param. `null`/default ⇒ param omitted. */
export function useQueryParam<T extends string | number>(
  name: string,
  defaultValue: T | null,
  parse: (raw: string) => T | null,
): WritableComputedRef<T | null> {
  const route = useRoute();
  const router = useRouter();
  return computed({
    get() {
      const raw = route.query[name];
      if (typeof raw !== "string" || raw === "") return defaultValue;
      const parsed = parse(raw);
      return parsed === null ? defaultValue : parsed;
    },
    set(value: T | null) {
      const query = { ...route.query };
      if (value === null || value === defaultValue) delete query[name];
      else query[name] = String(value);
      void router.replace({ query });
    },
  });
}

/** Integer filter param, e.g. ?year=2025. Non-integers fall back to the default. */
export function useQueryNumber(
  name: string,
  defaultValue: number | null,
): WritableComputedRef<number | null> {
  return useQueryParam<number>(name, defaultValue, (raw) => {
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
  });
}

/** Enum filter param, e.g. ?status=ready. Values outside `allowed` fall back to the default. */
export function useQueryEnum<T extends string>(
  name: string,
  defaultValue: T | null,
  allowed: readonly T[],
): WritableComputedRef<T | null> {
  return useQueryParam<T>(name, defaultValue, (raw) =>
    (allowed as readonly string[]).includes(raw) ? (raw as T) : null,
  );
}
