<script setup lang="ts">
/**
 * Address form — VeeValidate + the shared addressPayload Zod schema (spec 7:
 * form and API validation can never drift).
 */
import { useForm } from "vee-validate";
import { toTypedSchema } from "@vee-validate/zod";
import { addressPayload } from "@payroll/shared";
import InputText from "primevue/inputtext";

const { handleSubmit, defineField, errors } = useForm({
  validationSchema: toTypedSchema(addressPayload),
});

const [line1] = defineField("line1");
const [line2] = defineField("line2");
const [city] = defineField("city");
const [state] = defineField("state");
const [zip] = defineField("zip");
const [country] = defineField("country");

/** Validate + return the parsed payload (null when invalid — errors shown inline). */
async function validate(): Promise<Record<string, unknown> | null> {
  const result = await handleSubmit(async (values) => values)();
  return (result as Record<string, unknown> | undefined) ?? null;
}

defineExpose({ validate });
</script>

<template>
  <div class="form-grid">
    <div class="field" style="grid-column: 1 / -1">
      <label for="line1">Street address</label>
      <InputText id="line1" v-model="line1" :invalid="Boolean(errors.line1)" autocomplete="address-line1" />
      <small class="error-text">{{ errors.line1 }}</small>
    </div>
    <div class="field" style="grid-column: 1 / -1">
      <label for="line2">Apartment, suite, etc. (optional)</label>
      <InputText id="line2" v-model="line2" :invalid="Boolean(errors.line2)" autocomplete="address-line2" />
      <small class="error-text">{{ errors.line2 }}</small>
    </div>
    <div class="field">
      <label for="city">City</label>
      <InputText id="city" v-model="city" :invalid="Boolean(errors.city)" autocomplete="address-level2" />
      <small class="error-text">{{ errors.city }}</small>
    </div>
    <div class="field">
      <label for="state">State / Province</label>
      <InputText id="state" v-model="state" :invalid="Boolean(errors.state)" autocomplete="address-level1" />
      <small class="error-text">{{ errors.state }}</small>
    </div>
    <div class="field">
      <label for="zip">ZIP / Postal code</label>
      <InputText id="zip" v-model="zip" :invalid="Boolean(errors.zip)" autocomplete="postal-code" />
      <small class="error-text">{{ errors.zip }}</small>
    </div>
    <div class="field">
      <label for="country">Country (2-letter code)</label>
      <InputText id="country" v-model="country" placeholder="US" maxlength="2" :invalid="Boolean(errors.country)" />
      <small class="error-text">{{ errors.country }}</small>
    </div>
  </div>
</template>
