<script setup lang="ts">
/**
 * Tax-ID (TIN/SSN) form — shared taxIdPayload schema (identical client +
 * server validation). The TIN is sent over TLS once, encrypted at rest inside
 * the request payload, and only ever shown masked (••••1234) afterwards.
 */
import { useForm } from "vee-validate";
import { toTypedSchema } from "@vee-validate/zod";
import { taxIdPayload } from "@payroll/shared";
import InputMask from "primevue/inputmask";
import Message from "primevue/message";

const { handleSubmit, defineField, errors } = useForm({
  validationSchema: toTypedSchema(taxIdPayload),
});

const [taxId] = defineField("taxId");

async function validate(): Promise<Record<string, unknown> | null> {
  const result = await handleSubmit(async (values) => values)();
  return (result as Record<string, unknown> | undefined) ?? null;
}

defineExpose({ validate });
</script>

<template>
  <div>
    <Message severity="info" :closable="false" class="tin-note">
      Your tax ID is encrypted at rest and only ever shown masked (••••1234). An administrator
      reviews the change before it applies.
    </Message>
    <div class="form-grid">
      <div class="field">
        <label for="taxId">Tax ID / SSN (9 digits)</label>
        <InputMask id="taxId" v-model="taxId" mask="999999999" :invalid="Boolean(errors.taxId)" autocomplete="off" />
        <small class="error-text">{{ errors.taxId }}</small>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tin-note {
  margin-bottom: 1rem;
}
</style>
