<script setup lang="ts">
/**
 * Bank-details form — shared bankDetailsPayload schema (routing ABA checksum
 * enforced identically on client + server). The full account number is sent
 * over TLS once; only the masked form is ever displayed afterwards.
 */
import { useForm } from "vee-validate";
import { toTypedSchema } from "@vee-validate/zod";
import { bankDetailsPayload } from "@payroll/shared";
import InputMask from "primevue/inputmask";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Message from "primevue/message";

const { handleSubmit, defineField, errors } = useForm({
  validationSchema: toTypedSchema(bankDetailsPayload),
  initialValues: { type: "checking" },
});

const [routing] = defineField("routing");
const [account] = defineField("account");
const [type] = defineField("type");

const typeOptions = [
  { label: "Checking", value: "checking" },
  { label: "Savings", value: "savings" },
];

async function validate(): Promise<Record<string, unknown> | null> {
  const result = await handleSubmit(async (values) => values)();
  return (result as Record<string, unknown> | undefined) ?? null;
}

defineExpose({ validate });
</script>

<template>
  <div>
    <Message severity="info" :closable="false" class="bank-note">
      Bank details are encrypted at rest and only ever shown masked (••••1234).
    </Message>
    <div class="form-grid">
      <div class="field">
        <label for="type">Account type</label>
        <Select id="type" v-model="type" :options="typeOptions" option-label="label" option-value="value" :invalid="Boolean(errors.type)" />
        <small class="error-text">{{ errors.type }}</small>
      </div>
      <div class="field">
        <label for="routing">Routing number (9 digits)</label>
        <InputMask id="routing" v-model="routing" mask="999999999" :invalid="Boolean(errors.routing)" />
        <small class="error-text">{{ errors.routing }}</small>
      </div>
      <div class="field" style="grid-column: 1 / -1">
        <label for="account">Account number</label>
        <InputText id="account" v-model="account" inputmode="numeric" :invalid="Boolean(errors.account)" autocomplete="off" />
        <small class="error-text">{{ errors.account }}</small>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bank-note {
  margin-bottom: 1rem;
}
</style>
