<script setup lang="ts">
/**
 * Admin calendar (PAY-40): a purpose-built month grid aggregating every
 * company date obligation — scheduled paydays and actual payroll-run pay
 * dates, contractor recurring-invoice generation + payment-due days, tax
 * deposit due/deposited dates, filing deadlines + filed dates, and W-8 form
 * expiries. Events are read-only and link to the matching admin detail view.
 * All date handling is date-only (UTC date math, "YYYY-MM-DD" strings) — no
 * timezone conversion anywhere.
 */
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import Button from "primevue/button";
import Skeleton from "primevue/skeleton";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import { adminCalendarApi, type CalendarEvent, type CalendarEventKind } from "../../lib/api";
import { useQueryNumber } from "../../composables/useQueryFilters";
import { useNotify } from "../../composables/useNotify";

const router = useRouter();
const notify = useNotify();

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

// --------------------------------------------------------------------------
// Month state — ?year=&month= in the route query (bookmarkable, PAY-17
// pattern); defaults are the current month, so "Today" clears the params.
// --------------------------------------------------------------------------
const now = new Date();
const year = useQueryNumber("year", now.getFullYear());
const month = useQueryNumber("month", now.getMonth() + 1);
const resolvedYear = computed(() => year.value ?? now.getFullYear());
const resolvedMonth = computed(() => month.value ?? now.getMonth() + 1);

const loading = ref(true);
const events = ref<CalendarEvent[]>([]);

async function load() {
  loading.value = true;
  try {
    const res = await adminCalendarApi.month(resolvedYear.value, resolvedMonth.value);
    events.value = res.events;
  } catch (err) {
    notify.error(err, "Could not load the calendar");
  } finally {
    loading.value = false;
  }
}
watch([resolvedYear, resolvedMonth], load, { immediate: true });

function shiftMonth(delta: number) {
  // Date-only math in UTC: the 15th never crosses a month boundary.
  const base = new Date(Date.UTC(resolvedYear.value, resolvedMonth.value - 1 + delta, 15));
  year.value = base.getUTCFullYear();
  month.value = base.getUTCMonth() + 1;
}

function goToday() {
  year.value = null;
  month.value = null;
}

// --------------------------------------------------------------------------
// Grid — 6 fixed rows × 7 columns, Sunday first, adjacent-month days muted.
// --------------------------------------------------------------------------
interface Cell {
  iso: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
}

const todayIso = now.toISOString().slice(0, 10);

const cells = computed<Cell[]>(() => {
  const y = resolvedYear.value;
  const m = resolvedMonth.value;
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const daysInPrev = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  const result: Cell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const offset = i - firstWeekday; // 0 = the 1st of the month
    let iso: string;
    let day: number;
    let inMonth = true;
    if (offset < 0) {
      day = daysInPrev + offset + 1;
      const d = new Date(Date.UTC(y, m - 2, day));
      iso = d.toISOString().slice(0, 10);
      inMonth = false;
    } else if (offset >= daysInMonth) {
      day = offset - daysInMonth + 1;
      const d = new Date(Date.UTC(y, m, day));
      iso = d.toISOString().slice(0, 10);
      inMonth = false;
    } else {
      day = offset + 1;
      iso = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    result.push({ iso, day, inMonth, isToday: iso === todayIso });
  }
  return result;
});

const eventsByDate = computed<Map<string, CalendarEvent[]>>(() => {
  const map = new Map<string, CalendarEvent[]>();
  for (const event of events.value) {
    const list = map.get(event.date) ?? [];
    list.push(event);
    map.set(event.date, list);
  }
  return map;
});

// --------------------------------------------------------------------------
// Kind presentation — colour groups + legend.
// --------------------------------------------------------------------------
const KIND_META: Record<CalendarEventKind, { cls: string; legend: string }> = {
  payday_scheduled: { cls: "kind-payday", legend: "Scheduled payday" },
  payday_run: { cls: "kind-payday", legend: "Payroll run payday" },
  contractor_invoice: { cls: "kind-contractor", legend: "Contractor invoice generates" },
  contractor_payment: { cls: "kind-contractor", legend: "Contractor payment due" },
  deposit_due: { cls: "kind-deposit", legend: "Tax deposit due" },
  deposit_made: { cls: "kind-deposit", legend: "Tax deposit made" },
  filing_due: { cls: "kind-filing", legend: "Filing deadline" },
  filing_filed: { cls: "kind-filing", legend: "Filing filed" },
  filing_generates: { cls: "kind-filing-projected", legend: "Filing generates (projected)" },
  filing_due_projected: { cls: "kind-filing-projected", legend: "Filing deadline (projected)" },
  w8_expiry: { cls: "kind-w8", legend: "W-8 form expiry" },
};

const legend = [
  { cls: "kind-payday", label: "Paydays" },
  { cls: "kind-contractor", label: "Contractor invoices & payments" },
  { cls: "kind-deposit", label: "Tax deposits" },
  { cls: "kind-filing", label: "Filings" },
  { cls: "kind-filing-projected", label: "Projected filings" },
  { cls: "kind-w8", label: "W-8 expiries" },
];

function open(event: CalendarEvent) {
  if (event.link) void router.push({ name: event.link.name, params: event.link.params ?? {} });
}
</script>

<template>
  <div class="page stack">
    <PageHeader
      title="Calendar"
      subtitle="One month of company date obligations — paydays, contractor invoices and payments, tax deposits, filing deadlines, projected filing generation/due dates, and W-8 expiries. Read-only; events open the matching detail view."
    >
      <Button icon="pi pi-chevron-left" text rounded aria-label="Previous month" @click="shiftMonth(-1)" />
      <Button label="Today" text size="small" @click="goToday" />
      <Button icon="pi pi-chevron-right" text rounded aria-label="Next month" @click="shiftMonth(1)" />
    </PageHeader>

    <section class="card stack">
      <h2 class="month-title">{{ MONTH_NAMES[resolvedMonth - 1] }} {{ resolvedYear }}</h2>
      <Skeleton v-if="loading" height="24rem" />
      <template v-else>
        <div class="grid" role="grid" :aria-label="`${MONTH_NAMES[resolvedMonth - 1]} ${resolvedYear}`">
          <div v-for="wd in WEEKDAYS" :key="wd" class="weekday">{{ wd }}</div>
          <div
            v-for="cell in cells"
            :key="cell.iso"
            class="cell"
            :class="{ 'cell-out': !cell.inMonth, 'cell-today': cell.isToday }"
            role="gridcell"
          >
            <span class="day" :class="{ 'day-today': cell.isToday }">{{ cell.day }}</span>
            <button
              v-for="(event, i) in eventsByDate.get(cell.iso) ?? []"
              :key="i"
              type="button"
              class="event"
              :class="[KIND_META[event.kind].cls, { 'event-link': event.link }]"
              :title="event.detail ? `${event.label} — ${event.detail}` : event.label"
              @click="open(event)"
            >
              {{ event.label }}
            </button>
          </div>
        </div>
        <EmptyState
          v-if="events.length === 0"
          icon="pi pi-calendar"
          title="Nothing on the calendar this month"
          body="Events appear as payroll runs, deposit rows, filings, and recurring contractor templates accumulate."
        />
        <div class="legend">
          <span v-for="item in legend" :key="item.label" class="legend-item">
            <span class="legend-dot" :class="item.cls" />{{ item.label }}
          </span>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.month-title {
  margin: 0;
  font-size: 1.25rem;
}
.grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
  background: var(--p-content-border-color, #e5e7eb);
  border: 1px solid var(--p-content-border-color, #e5e7eb);
  border-radius: 8px;
  overflow: hidden;
}
.weekday {
  background: var(--p-content-background, #fff);
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color, #6b7280);
  padding: 0.375rem 0.5rem;
}
.cell {
  background: var(--p-content-background, #fff);
  min-height: 6.5rem;
  padding: 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cell-out {
  background: var(--p-surface-50, #f9fafb);
}
.cell-out .day {
  color: var(--p-text-muted-color, #9ca3af);
}
.day {
  font-size: 0.8rem;
  font-weight: 600;
  padding: 0 0.25rem;
}
.day-today {
  display: inline-block;
  background: var(--p-primary-color, #2563eb);
  color: var(--p-primary-contrast-color, #fff);
  border-radius: 9999px;
  min-width: 1.4rem;
  text-align: center;
  padding: 0.1rem 0;
}
.event {
  border: none;
  border-radius: 4px;
  font-size: 0.72rem;
  line-height: 1.25;
  text-align: left;
  padding: 0.15rem 0.35rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: default;
}
.event-link {
  cursor: pointer;
}
.event-link:hover {
  filter: brightness(0.94);
}
.kind-payday {
  background: var(--p-green-100, #dcfce7);
  color: var(--p-green-800, #166534);
}
.kind-contractor {
  background: var(--p-blue-100, #dbeafe);
  color: var(--p-blue-800, #1e40af);
}
.kind-deposit {
  background: var(--p-amber-100, #fef3c7);
  color: var(--p-amber-800, #92400e);
}
.kind-filing {
  background: var(--p-purple-100, #f3e8ff);
  color: var(--p-purple-800, #6b21a8);
}
.kind-filing-projected {
  background: var(--p-purple-50, #faf5ff);
  color: var(--p-purple-800, #6b21a8);
  border: 1px dashed var(--p-purple-300, #d8b4fe);
}
.kind-w8 {
  background: var(--p-red-100, #fee2e2);
  color: var(--p-red-800, #991b1b);
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  font-size: 0.8rem;
  color: var(--p-text-muted-color, #6b7280);
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.legend-dot {
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 9999px;
  display: inline-block;
}
@media (max-width: 720px) {
  .cell {
    min-height: 4.5rem;
  }
  .event {
    font-size: 0.65rem;
  }
}
</style>
