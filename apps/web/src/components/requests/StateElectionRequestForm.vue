<script setup lang="ts">
/**
 * State withholding election form (PAY-13 phase 2) — shared
 * stateElectionPayload schema. effective_from is owned by the wizard
 * (top-level); this form fills the rest. Mirrors W4RequestForm.
 */
import { computed } from "vue";
import { useField, useForm } from "vee-validate";
import { toTypedSchema } from "@vee-validate/zod";
import {
  STATE_ELECTION_EXEMPT_MESSAGE,
  stateElectionExemptCheck,
  stateElectionFields,
} from "@payroll/shared";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Checkbox from "primevue/checkbox";
import DatePicker from "primevue/datepicker";
import Textarea from "primevue/textarea";
import { z } from "zod";

// Wizard injects effectiveFrom at submit time; validate the rest here.
//
// Two schemas, one source of truth:
// - castSafeSchema feeds vee-validate: its initial values MUST parse, because
//   @vee-validate/zod's cast() walks schema defaults on a failed parse and
//   crashes on zod v4 ("_def.defaultValue is not a function"). stateCode's
//   initial value is "" (user must pick a state), so the cast schema also
//   accepts empty; the strict rule runs in validate().
// - strictSchema runs manually in validate(): the real regex + the exempt
//   rule (a .refine()d schema can't go through toTypedSchema either — same
//   defaults walker chokes on the ZodEffects wrapper).
const castSafeSchema = stateElectionFields.omit({ effectiveFrom: true }).extend({
  stateCode: z.string().regex(/^([A-Z]{2})?$/, "expected a 2-letter state code"),
});
const strictSchema = stateElectionFields.omit({ effectiveFrom: true }).refine(
  stateElectionExemptCheck,
  { message: STATE_ELECTION_EXEMPT_MESSAGE, path: ["exempt"] },
);
type StateElectionFormValues = z.input<typeof castSafeSchema>;

// Explicit generic + useField<number> for the numeric fields: primevue 5
// tightened InputNumber's v-model to Nullable<number>, and defineField
// returns Ref<unknown> in this vee-validate version — useField<T> is the
// typed registration path (same workaround as W4RequestForm).
const { handleSubmit, defineField, setFieldError, errors } = useForm<StateElectionFormValues>({
  validationSchema: toTypedSchema(castSafeSchema),
  initialValues: {
    stateCode: "",
    filingStatus: "single",
    allowances: 0,
    additionalAllowances: 0,
    extraWithholding: 0,
    exempt: false,
    filedDate: new Date().toISOString().slice(0, 10),
    note: "",
  },
});

const [stateCodeModel] = defineField("stateCode");
const [filingStatus] = defineField("filingStatus");
const { value: allowances } = useField<number>("allowances");
const { value: additionalAllowances } = useField<number>("additionalAllowances");
const { value: extraWithholding } = useField<number>("extraWithholding");
const [exempt] = defineField("exempt");
const [filedDateModel] = defineField("filedDate");
const [note] = defineField("note");

// Schema requires uppercase 2-letter code; normalize as the user types.
const stateCode = computed({
  get: (): string => (typeof stateCodeModel.value === "string" ? stateCodeModel.value : ""),
  set: (v: string) => {
    stateCodeModel.value = v.toUpperCase().slice(0, 2);
  },
});

// DatePicker works with Date; the schema wants YYYY-MM-DD (local, no UTC shift).
const filedDate = computed({
  get: (): Date | null => {
    const v = filedDateModel.value;
    return typeof v === "string" && v ? new Date(`${v}T00:00:00`) : null;
  },
  set: (d: Date | null) => {
    filedDateModel.value = d
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
      : "";
  },
});

const filingOptions: { label: string; value: StateElectionFormValues["filingStatus"] }[] = [
  { label: "Single", value: "single" },
  { label: "Married filing jointly", value: "married_joint" },
  { label: "Married filing separately", value: "married_separate" },
  { label: "Head of household", value: "head_of_household" },
];

async function validate(): Promise<Record<string, unknown> | null> {
  const result = await handleSubmit(async (values) => values)();
  if (!result) return null;
  // Strict pass: the real state-code regex + the exempt rule, with issues
  // mapped back onto their fields (the server re-validates identically).
  const strict = strictSchema.safeParse(result);
  if (!strict.success) {
    for (const issue of strict.error.issues) {
      setFieldError(issue.path[0] as "stateCode", issue.message);
    }
    return null;
  }
  return strict.data as Record<string, unknown>;
}

defineExpose({ validate });
</script>

<template>
  <div class="form-grid">
    <div class="field">
      <label for="stateCode">State</label>
      <InputText id="stateCode" v-model="stateCode" maxlength="2" placeholder="IL" style="text-transform: uppercase; max-width: 6rem" :invalid="Boolean(errors.stateCode)" />
      <small class="error-text">{{ errors.stateCode }}</small>
    </div>
    <div class="field">
      <label for="filingStatus">Filing status</label>
      <Select id="filingStatus" v-model="filingStatus" :options="filingOptions" option-label="label" option-value="value" :invalid="Boolean(errors.filingStatus)" />
      <small class="error-text">{{ errors.filingStatus }}</small>
    </div>
    <div class="field">
      <label for="allowances">Allowances</label>
      <InputNumber id="allowances" v-model="allowances" :min="0" :max="99" :use-grouping="false" :invalid="Boolean(errors.allowances)" />
      <small class="error-text">{{ errors.allowances }}</small>
    </div>
    <div class="field">
      <label for="additionalAllowances">Additional allowances</label>
      <InputNumber id="additionalAllowances" v-model="additionalAllowances" :min="0" :max="99" :use-grouping="false" :invalid="Boolean(errors.additionalAllowances)" />
      <small class="error-text">{{ errors.additionalAllowances }}</small>
    </div>
    <div class="field">
      <label for="extraWithholding">Extra withholding (per pay period)</label>
      <InputNumber id="extraWithholding" v-model="extraWithholding" mode="currency" currency="USD" :invalid="Boolean(errors.extraWithholding)" />
      <small class="error-text">{{ errors.extraWithholding }}</small>
    </div>
    <div class="field">
      <label for="filedDate">Date filed</label>
      <DatePicker id="filedDate" v-model="filedDate" date-format="yy-mm-dd" :invalid="Boolean(errors.filedDate)" />
      <small class="error-text">{{ errors.filedDate }}</small>
    </div>
    <div class="field">
      <label for="note">Note (optional)</label>
      <Textarea id="note" v-model="note" rows="2" :invalid="Boolean(errors.note)" />
      <small class="error-text">{{ errors.note }}</small>
    </div>
    <div class="field" style="grid-column: 1 / -1">
      <span class="row"><Checkbox v-model="exempt" binary input-id="exempt" /><label for="exempt">Exempt from state withholding</label></span>
      <small class="muted">An exempt election cannot also claim allowances or extra withholding.</small>
      <small class="error-text">{{ errors.exempt }}</small>
    </div>
  </div>
</template>
