<script setup lang="ts">
/**
 * Legal-name form — shared legalNamePayload schema (name + required reason;
 * the name appears on payslips, so the audit trail is emphasized).
 */
import { useForm } from "vee-validate";
import { toTypedSchema } from "@vee-validate/zod";
import { legalNamePayload } from "@payroll/shared";
import InputText from "primevue/inputtext";
import Textarea from "primevue/textarea";
import Message from "primevue/message";

const { handleSubmit, defineField, errors } = useForm({
  validationSchema: toTypedSchema(legalNamePayload),
});

const [legalName] = defineField("legalName");
const [reason] = defineField("reason");

async function validate(): Promise<Record<string, unknown> | null> {
  const result = await handleSubmit(async (values) => values)();
  return (result as Record<string, unknown> | undefined) ?? null;
}

defineExpose({ validate });
</script>

<template>
  <div>
    <Message severity="warn" :closable="false" class="name-note">
      Your legal name appears on payslips and tax documents. The change is
      recorded with the previous value and your reason.
    </Message>
    <div class="field">
      <label for="legalName">New legal name</label>
      <InputText id="legalName" v-model="legalName" :invalid="Boolean(errors.legalName)" autocomplete="name" />
      <small class="error-text">{{ errors.legalName }}</small>
    </div>
    <div class="field">
      <label for="reason">Reason (required)</label>
      <Textarea id="reason" v-model="reason" rows="3" :invalid="Boolean(errors.reason)" placeholder="e.g. marriage, court order, spelling correction" />
      <small class="error-text">{{ errors.reason }}</small>
    </div>
  </div>
</template>

<style scoped>
.name-note {
  margin-bottom: 1rem;
}
</style>
