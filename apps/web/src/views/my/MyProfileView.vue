<script setup lang="ts">
/**
 * Profile (frontend spec): read-only current info (address, W-4 summary,
 * bank masked, legal name) + per-section "Request change".
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import Button from "primevue/button";
import Skeleton from "primevue/skeleton";
import PageHeader from "../../components/PageHeader.vue";
import { myApi, type MyProfile, type ChangeRequestType } from "../../lib/api";
import { filingStatusLabel } from "../../composables/useRequestTypes";
import { useMoney } from "../../composables/useMoney";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

const router = useRouter();
const { money } = useMoney();
const { date } = useDates();
const notify = useNotify();

const loading = ref(true);
const profile = ref<MyProfile | null>(null);

function requestChange(type: ChangeRequestType) {
  void router.push({ name: "my-request-new", query: { type } });
}

onMounted(async () => {
  try {
    const { profile: p } = await myApi.profile();
    profile.value = p;
  } catch (err) {
    notify.error(err, "Could not load your profile");
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="Profile" subtitle="Your information on file. Changes go through an approval request." />

    <Skeleton v-if="loading" height="20rem" />

    <template v-else-if="profile">
      <section class="card">
        <div class="card-head">
          <h3>Identity</h3>
          <Button label="Request change" size="small" text @click="requestChange('legal_name')" />
        </div>
        <dl class="kv">
          <dt>Legal name</dt>
          <dd>{{ profile.legalName }}</dd>
          <dt>Preferred name</dt>
          <dd>{{ profile.preferredName ?? "—" }}</dd>
          <dt>Employment type</dt>
          <dd>{{ profile.employmentType }}</dd>
          <dt>Hire date</dt>
          <dd>{{ date(profile.hireDate) }}</dd>
          <dt>Tax ID</dt>
          <dd>{{ profile.taxIdMasked ?? "—" }} <span class="muted small">(changes handled by your admin)</span></dd>
        </dl>
      </section>

      <section class="card">
        <div class="card-head">
          <h3>Address</h3>
          <Button label="Request change" size="small" text @click="requestChange('address')" />
        </div>
        <dl v-if="profile.address" class="kv">
          <dt>Street</dt>
          <dd>{{ profile.address.line1 }}<template v-if="profile.address.line2">, {{ profile.address.line2 }}</template></dd>
          <dt>City</dt>
          <dd>{{ profile.address.city }}</dd>
          <dt>State/Province</dt>
          <dd>{{ profile.address.state }}</dd>
          <dt>ZIP/Postal code</dt>
          <dd>{{ profile.address.zip }}</dd>
          <dt>Country</dt>
          <dd>{{ profile.address.country }}</dd>
        </dl>
        <p v-else class="muted">No address on file.</p>
      </section>

      <section class="card">
        <div class="card-head">
          <h3>Bank details</h3>
          <Button label="Request change" size="small" text @click="requestChange('bank_details')" />
        </div>
        <dl v-if="profile.bankDetails" class="kv">
          <dt>Account type</dt>
          <dd>{{ profile.bankDetails.type ?? "—" }}</dd>
          <dt>Routing number</dt>
          <dd>{{ profile.bankDetails.routingMasked ?? "—" }}</dd>
          <dt>Account number</dt>
          <dd>{{ profile.bankDetails.accountMasked ?? "—" }}</dd>
        </dl>
        <p v-else class="muted">No bank details on file.</p>
      </section>

      <section class="card">
        <div class="card-head">
          <h3>Withholding (W-4)</h3>
          <Button label="Request change" size="small" text @click="requestChange('w4')" />
        </div>
        <dl v-if="profile.w4" class="kv">
          <dt>Tax year</dt>
          <dd>{{ profile.w4.taxYear }}</dd>
          <dt>Filing status</dt>
          <dd>{{ filingStatusLabel(profile.w4.filingStatus) }}</dd>
          <dt>Federal exempt</dt>
          <dd>{{ profile.w4.federalExempt ? "Yes" : "No" }}</dd>
          <dt>Extra withholding</dt>
          <dd>{{ money(profile.w4.extraWithholding) }} per period</dd>
          <dt>Effective from</dt>
          <dd>{{ date(profile.w4.effectiveFrom) }}</dd>
        </dl>
        <p v-else class="muted">No W-4 election on file — the default (single) applies.</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}
.card-head h3 {
  margin: 0;
}
</style>
