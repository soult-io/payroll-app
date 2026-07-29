<script setup lang="ts">
/**
 * "Request a change" wizard (frontend spec): type picker → type-specific
 * form (shared Zod schemas) → review + effective-date → submit.
 * Stepper component per spec's onboarding precedent.
 */
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import Button from "primevue/button";
import DatePicker from "primevue/datepicker";
import Stepper from "primevue/stepper";
import StepList from "primevue/steplist";
import Step from "primevue/step";
import StepPanels from "primevue/steppanels";
import StepPanel from "primevue/steppanel";
import PageHeader from "../../components/PageHeader.vue";
import RequestPayloadView from "../../components/RequestPayloadView.vue";
import AddressRequestForm from "../../components/requests/AddressRequestForm.vue";
import W4RequestForm from "../../components/requests/W4RequestForm.vue";
import BankRequestForm from "../../components/requests/BankRequestForm.vue";
import LegalNameRequestForm from "../../components/requests/LegalNameRequestForm.vue";
import { REQUEST_TYPES, requestTypeLabel } from "../../composables/useRequestTypes";
import { changeRequestsApi, type ChangeRequestType } from "../../lib/api";
import { useDates } from "../../composables/useDates";
import { useNotify } from "../../composables/useNotify";

interface TypeForm {
  validate: () => Promise<Record<string, unknown> | null>;
}

const route = useRoute();
const router = useRouter();
const notify = useNotify();
const { toIso } = useDates();

const typeOptions = REQUEST_TYPES;
const queryType = typeof route.query.type === "string" ? route.query.type : null;
const selectedType = ref<ChangeRequestType | null>(
  typeOptions.some((t) => t.value === queryType) ? (queryType as ChangeRequestType) : null,
);
const activeStep = ref(selectedType.value ? "2" : "1");

const formRef = ref<TypeForm | null>(null);
const payload = ref<Record<string, unknown> | null>(null);

// Effective-date picker, default = first of next month (never retroactive).
function firstOfNextMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}
const effectiveFrom = ref<Date>(firstOfNextMonth());

const busy = ref(false);
const formComponent = computed(() => {
  switch (selectedType.value) {
    case "address":
      return AddressRequestForm;
    case "w4":
      return W4RequestForm;
    case "bank_details":
      return BankRequestForm;
    case "legal_name":
      return LegalNameRequestForm;
    default:
      return null;
  }
});

function pickType(type: ChangeRequestType) {
  selectedType.value = type;
  payload.value = null;
  activeStep.value = "2";
}

async function toReview() {
  if (!formRef.value) return;
  const parsed = await formRef.value.validate();
  if (!parsed) return; // inline errors shown by the form
  payload.value = parsed;
  activeStep.value = "3";
}

async function submit() {
  if (!selectedType.value || !payload.value) return;
  const effectiveIso = toIso(effectiveFrom.value);
  if (!effectiveIso) {
    notify.error(new Error("Pick an effective date."), "Missing date");
    return;
  }
  busy.value = true;
  try {
    const { request } = await changeRequestsApi.submit({
      requestType: selectedType.value,
      payload: payload.value,
      effectiveFrom: effectiveIso,
    });
    notify.success("Request submitted", "Your administrator will review it.");
    await router.push({ name: "my-request-detail", params: { publicId: request.publicId } });
  } catch (err) {
    notify.error(err, "Could not submit request");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page stack">
    <PageHeader title="Request a change" subtitle="Changes take effect after administrator approval." />

    <div class="card">
      <Stepper v-model:value="activeStep" linear>
        <StepList>
          <Step value="1">Type</Step>
          <Step value="2" :disabled="!selectedType">Details</Step>
          <Step value="3" :disabled="!payload">Review</Step>
        </StepList>
        <StepPanels>
          <StepPanel value="1">
            <div class="type-grid">
              <button
                v-for="t in typeOptions"
                :key="t.value"
                type="button"
                class="type-card"
                :class="{ selected: selectedType === t.value }"
                @click="pickType(t.value)"
              >
                <i :class="t.icon" aria-hidden="true" />
                <strong>{{ t.label }}</strong>
                <span class="muted small">{{ t.blurb }}</span>
              </button>
            </div>
          </StepPanel>

          <StepPanel value="2">
            <h3 class="step-title">{{ selectedType ? requestTypeLabel(selectedType) : "" }}</h3>
            <component :is="formComponent" v-if="formComponent" ref="formRef" :key="selectedType ?? 'none'" />
            <div class="step-actions">
              <Button label="Back" text icon="pi pi-arrow-left" @click="activeStep = '1'" />
              <Button label="Review" icon="pi pi-arrow-right" icon-pos="right" @click="toReview" />
            </div>
          </StepPanel>

          <StepPanel value="3">
            <h3 class="step-title">Review — {{ selectedType ? requestTypeLabel(selectedType) : "" }}</h3>
            <div class="field" style="max-width: 260px">
              <label for="effectiveFrom">Effective from</label>
              <DatePicker id="effectiveFrom" v-model="effectiveFrom" date-format="yy-mm-dd" :min-date="new Date()" show-icon />
              <small class="muted">Applies to pay periods on/after this date — never retroactive.</small>
            </div>
            <RequestPayloadView v-if="selectedType && payload" :request-type="selectedType" :payload="payload" />
            <div class="step-actions">
              <Button label="Back" text icon="pi pi-arrow-left" @click="activeStep = '2'" />
              <Button label="Submit request" icon="pi pi-check" :loading="busy" @click="submit" />
            </div>
          </StepPanel>
        </StepPanels>
      </Stepper>
    </div>
  </div>
</template>

<style scoped>
.type-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
  padding: 1rem 0;
}
.type-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.4rem;
  padding: 1rem;
  border: 1px solid var(--p-surface-border, #e4e4e7);
  border-radius: 10px;
  background: var(--p-surface-card, #fff);
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.type-card:hover {
  border-color: var(--p-primary-color, #3366cc);
}
.type-card.selected {
  border-color: var(--p-primary-color, #3366cc);
  box-shadow: 0 0 0 1px var(--p-primary-color, #3366cc);
}
.type-card .pi {
  font-size: 1.4rem;
  color: var(--p-primary-color, #3366cc);
}
.step-title {
  margin: 0 0 1rem;
}
.step-actions {
  display: flex;
  justify-content: space-between;
  margin-top: 1.25rem;
}
</style>
