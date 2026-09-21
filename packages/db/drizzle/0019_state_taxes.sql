CREATE TABLE "employee_work_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"state_code" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "employee_work_states_employee_effective_uniq" UNIQUE("employee_id","effective_from"),
	CONSTRAINT "employee_work_states_code_check" CHECK ("employee_work_states"."state_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "state_tax_brackets" (
	"id" serial PRIMARY KEY NOT NULL,
	"jurisdiction" text NOT NULL,
	"tax_year" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"min_amount" numeric(12, 2) NOT NULL,
	"max_amount" numeric(12, 2),
	"rate" numeric(6, 5) NOT NULL,
	CONSTRAINT "state_tax_brackets_jurisdiction_year_ordinal_uniq" UNIQUE("jurisdiction","tax_year","ordinal")
);
--> statement-breakpoint
CREATE TABLE "state_tax_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"jurisdiction" text NOT NULL,
	"tax_year" integer NOT NULL,
	"kind" text NOT NULL,
	"flat_rate" numeric(6, 5),
	"standard_deduction" numeric(12, 2),
	"standard_deduction_alt" numeric(12, 2),
	"alt_min_allowances" integer,
	"low_income_exemption" numeric(12, 2),
	"low_income_exemption_alt" numeric(12, 2),
	"allowance_deduction" numeric(12, 2),
	"allowance_credit" numeric(12, 2),
	"additional_allowance_deduction" numeric(12, 2),
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "state_tax_configs_jurisdiction_year_uniq" UNIQUE("jurisdiction","tax_year"),
	CONSTRAINT "state_tax_configs_kind_check" CHECK ("state_tax_configs"."kind" IN ('none','flat','progressive'))
);
--> statement-breakpoint
CREATE TABLE "state_withholding_elections" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"state_code" text NOT NULL,
	"filing_status" text DEFAULT 'single' NOT NULL,
	"allowances" integer DEFAULT 0 NOT NULL,
	"additional_allowances" integer DEFAULT 0 NOT NULL,
	"extra_withholding" numeric(12, 2) DEFAULT '0' NOT NULL,
	"exempt" boolean DEFAULT false NOT NULL,
	"effective_from" date NOT NULL,
	"filed_date" date NOT NULL,
	"note" text DEFAULT '',
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "state_withholding_elections_employee_state_effective_uniq" UNIQUE("employee_id","state_code","effective_from"),
	CONSTRAINT "state_withholding_elections_status_check" CHECK ("state_withholding_elections"."filing_status" IN ('single','married_joint','married_separate','head_of_household')),
	CONSTRAINT "state_withholding_elections_allowances_check" CHECK ("state_withholding_elections"."allowances" >= 0),
	CONSTRAINT "state_withholding_elections_additional_check" CHECK ("state_withholding_elections"."additional_allowances" >= 0)
);
--> statement-breakpoint
ALTER TABLE "employee_work_states" ADD CONSTRAINT "employee_work_states_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_withholding_elections" ADD CONSTRAINT "state_withholding_elections_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;