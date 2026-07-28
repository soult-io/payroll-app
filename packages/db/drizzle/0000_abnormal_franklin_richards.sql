CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "auth_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text,
	"event" text NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "change_request_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" integer NOT NULL,
	"request_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"effective_from" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now(),
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "change_requests_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "change_requests_type_check" CHECK ("change_requests"."request_type" IN ('address','w4','bank_details','legal_name')),
	CONSTRAINT "change_requests_status_check" CHECK ("change_requests"."status" IN ('pending','approved','denied','withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "company" (
	"id" serial PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"ein" text,
	"address" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "compensation" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"period_amount" numeric(12, 2) NOT NULL,
	"frequency" text DEFAULT 'monthly' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "compensation_employee_effective_from_uniq" UNIQUE("employee_id","effective_from"),
	CONSTRAINT "compensation_frequency_check" CHECK ("compensation"."frequency" IN ('weekly','biweekly','semimonthly','monthly'))
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"subject" text NOT NULL,
	"body_html" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"sent_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "email_outbox_status_check" CHECK ("email_outbox"."status" IN ('pending','sent','failed'))
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text,
	"company_id" integer NOT NULL,
	"employment_type" text DEFAULT 'w2' NOT NULL,
	"legal_name" text NOT NULL,
	"preferred_name" text,
	"date_of_birth" date,
	"tax_id" text,
	"address" jsonb,
	"bank_details" jsonb,
	"hire_date" date NOT NULL,
	"termination_date" date,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "employees_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "employees_employment_type_check" CHECK ("employees"."employment_type" IN ('w2','1099')),
	CONSTRAINT "employees_status_check" CHECK ("employees"."status" IN ('active','terminated'))
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "notification_settings_user_id_event_type_pk" PRIMARY KEY("user_id","event_type")
);
--> statement-breakpoint
CREATE TABLE "pay_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer,
	"frequency" text DEFAULT 'monthly' NOT NULL,
	"draft_day_of_month" integer DEFAULT 15 NOT NULL,
	"pay_day_of_month" integer DEFAULT 15 NOT NULL,
	"auto_draft" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "pay_schedules_frequency_check" CHECK ("pay_schedules"."frequency" IN ('weekly','biweekly','semimonthly','monthly')),
	CONSTRAINT "pay_schedules_draft_day_check" CHECK ("pay_schedules"."draft_day_of_month" BETWEEN 1 AND 28),
	CONSTRAINT "pay_schedules_pay_day_check" CHECK ("pay_schedules"."pay_day_of_month" BETWEEN 1 AND 28)
);
--> statement-breakpoint
CREATE TABLE "payroll_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"category" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "payroll_entries_run_category_uniq" UNIQUE("run_id","category"),
	CONSTRAINT "payroll_entries_category_check" CHECK ("payroll_entries"."category" IN ('gross_pay','federal_withholding','social_security','medicare','state_withholding','net_pay','employer_social_security','employer_medicare','employer_futa'))
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"pay_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"run_snapshot" jsonb NOT NULL,
	"created_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "payroll_runs_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payroll_runs_employee_period_start_uniq" UNIQUE("employee_id","period_start"),
	CONSTRAINT "payroll_runs_status_check" CHECK ("payroll_runs"."status" IN ('draft','awaiting_approval','approved','issued','void'))
);
--> statement-breakpoint
CREATE TABLE "tax_brackets" (
	"id" serial PRIMARY KEY NOT NULL,
	"jurisdiction" text DEFAULT 'federal' NOT NULL,
	"tax_year" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"min_amount" numeric(12, 2) NOT NULL,
	"max_amount" numeric(12, 2),
	"rate" numeric(6, 5) NOT NULL,
	CONSTRAINT "tax_brackets_jurisdiction_year_ordinal_uniq" UNIQUE("jurisdiction","tax_year","ordinal")
);
--> statement-breakpoint
CREATE TABLE "tax_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"jurisdiction" text DEFAULT 'federal' NOT NULL,
	"tax_year" integer NOT NULL,
	"standard_deduction" numeric(12, 2) NOT NULL,
	"social_security_rate" numeric(6, 5) NOT NULL,
	"social_security_wage_cap" numeric(12, 2) NOT NULL,
	"medicare_rate" numeric(6, 5) NOT NULL,
	"medicare_additional_rate" numeric(6, 5) NOT NULL,
	"medicare_additional_threshold" numeric(12, 2) NOT NULL,
	"state_withholding_rate" numeric(6, 5) DEFAULT '0' NOT NULL,
	"employer_social_security_rate" numeric(6, 5) NOT NULL,
	"employer_medicare_rate" numeric(6, 5) NOT NULL,
	"futa_rate" numeric(6, 5) NOT NULL,
	"futa_wage_cap" numeric(12, 2) NOT NULL,
	CONSTRAINT "tax_config_jurisdiction_year_uniq" UNIQUE("jurisdiction","tax_year")
);
--> statement-breakpoint
CREATE TABLE "time_off" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"date" date NOT NULL,
	"type" text NOT NULL,
	"note" text DEFAULT '',
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "time_off_employee_date_uniq" UNIQUE("employee_id","date"),
	CONSTRAINT "time_off_type_check" CHECK ("time_off"."type" IN ('sick','vacation','holiday','other'))
);
--> statement-breakpoint
CREATE TABLE "w4_elections" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"tax_year" integer NOT NULL,
	"filing_status" text DEFAULT 'single' NOT NULL,
	"federal_exempt" boolean DEFAULT false NOT NULL,
	"multiple_jobs" boolean DEFAULT false NOT NULL,
	"dependents_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"other_income" numeric(12, 2) DEFAULT '0' NOT NULL,
	"deductions_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"extra_withholding" numeric(12, 2) DEFAULT '0' NOT NULL,
	"effective_from" date NOT NULL,
	"filed_date" date NOT NULL,
	"renewal_deadline" date,
	"note" text DEFAULT '',
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "w4_elections_employee_year_effective_uniq" UNIQUE("employee_id","tax_year","effective_from"),
	CONSTRAINT "w4_elections_filing_status_check" CHECK ("w4_elections"."filing_status" IN ('single','married_joint','married_separate','head_of_household'))
);
--> statement-breakpoint
ALTER TABLE "change_request_comments" ADD CONSTRAINT "change_request_comments_request_id_change_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."change_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation" ADD CONSTRAINT "compensation_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_schedules" ADD CONSTRAINT "pay_schedules_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "w4_elections" ADD CONSTRAINT "w4_elections_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_requests_one_pending_per_field" ON "change_requests" USING btree ("employee_id","request_type") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "email_outbox_status_idx" ON "email_outbox" USING btree ("status");