<script setup lang="ts">
/**
 * Payslip detail (frontend spec): earnings/deductions/employer-cost
 * breakdown from the frozen snapshot + Download PDF button.
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

      <section class="card">
        <h3>Employer contributions</h3>
        <dl class="kv">
          <dt>Social Security</dt>
          <dd>{{ money(payslip.snapshot.result.employerSocialSecurity) }}</dd>
          <dt>Medicare</dt>
          <dd>{{ money(payslip.snapshot.result.employerMedicare) }}</dd>
          <dt>FUTA</dt>
          <dd>{{ money(payslip.snapshot.result.employerFUTA) }}</dd>
        </dl>
        <p class="muted small" style="margin-top: 1rem">
          Employer contributions are paid by the company on top of your gross pay.
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
