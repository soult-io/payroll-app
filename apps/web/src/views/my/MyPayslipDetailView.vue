<script setup lang="ts">
/**
 * Payslip detail (frontend spec): earnings/deductions breakdown and the
 * year-to-date block, all from the frozen snapshot + Download PDF button.
 * Employer-side costs are deliberately not shown to the employee (owner
 * decision 2026-07-30) — they remain visible in the admin run view.
 */
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import Button from "primevue/button";
import Skeleton from "primevue/skeleton";
import PageHeader from "../../components/PageHeader.vue";
import EmptyState from "../../components/EmptyState.vue";
import { payslipsApi, type PayslipDetail } from "../../lib/api";
import { useMoney } from "../../composables/useMoney";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

const route = useRoute();
const { money } = useMoney();
const { date } = useDates();
const notify = useNotify();

const loading = ref(true);
const payslip = ref<PayslipDetail | null>(null);

const publicId = route.params.publicId as string;

onMounted(async () => {
  try {
    const { payslip: detail } = await payslipsApi.detail(publicId);
    payslip.value = detail;
  } catch (err) {
    notify.error(err, "Could not load payslip");
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="page stack">
    <PageHeader
      title="Payslip"
      :subtitle="payslip ? `${date(payslip.periodStart)} – ${date(payslip.periodEnd)} · pay date ${date(payslip.payDate)}` : undefined"
    >
      <a v-if="payslip" :href="payslipsApi.pdfUrl(payslip.publicId)" target="_blank" rel="noopener">
        <Button label="Download PDF" icon="pi pi-download" />
      </a>
    </PageHeader>

    <Skeleton v-if="loading" height="16rem" />

    <EmptyState
      v-else-if="!payslip"
      icon="pi pi-exclamation-circle"
      title="Payslip not found"
      body="It may not be issued yet, or the link is wrong."
    />

    <div v-else class="grid-2">
      <section class="card">
        <h3>Your pay</h3>
        <dl class="kv">
          <dt>Gross pay</dt>
          <dd>{{ money(payslip.snapshot.result.grossPay) }}</dd>
          <dt>Federal withholding</dt>
          <dd>−{{ money(payslip.snapshot.result.federalWithholding) }}</dd>
          <dt>Social Security</dt>
          <dd>−{{ money(payslip.snapshot.result.socialSecurity) }}</dd>
          <dt>Medicare</dt>
          <dd>−{{ money(payslip.snapshot.result.medicare) }}</dd>
          <dt>State withholding</dt>
          <dd>−{{ money(payslip.snapshot.result.stateWithholding) }}</dd>
          <dt><strong>Net pay</strong></dt>
          <dd><strong>{{ money(payslip.snapshot.result.netPay) }}</strong></dd>
        </dl>
      </section>

      <section v-if="payslip.snapshot.ytd" class="card">
        <h3>Year to date</h3>
        <dl class="kv">
          <dt>YTD gross</dt>
          <dd>{{ money(payslip.snapshot.ytd.gross) }}</dd>
          <dt>YTD withholdings</dt>
          <dd>−{{ money(payslip.snapshot.ytd.totalDeductions) }}</dd>
          <dt><strong>YTD net pay</strong></dt>
          <dd><strong>{{ money(payslip.snapshot.ytd.netPay) }}</strong></dd>
        </dl>
        <p class="muted small" style="margin-top: 1rem">
          Totals include this payslip and all earlier payslips this calendar year.
        </p>
      </section>

      <section class="card">
        <h3>Details</h3>
        <dl class="kv">
          <dt>Employee</dt>
          <dd>{{ payslip.snapshot.inputs.employee.legalName }}</dd>
          <dt>Company</dt>
          <dd>{{ payslip.snapshot.inputs.company.legalName }}</dd>
          <dt>Pay frequency</dt>
          <dd>{{ payslip.snapshot.inputs.frequency }}</dd>
          <dt>Snapshot hash</dt>
          <dd class="mono">{{ payslip.snapshotHash.slice(0, 16) }}…</dd>
          <dt>Issued</dt>
          <dd>{{ date(payslip.issuedAt) }}</dd>
        </dl>
      </section>
    </div>
  </div>
</template>
