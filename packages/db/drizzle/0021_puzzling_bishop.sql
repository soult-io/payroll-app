CREATE TABLE "state_deposit_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"state_code" text NOT NULL,
	"tax_year" integer NOT NULL,
	"frequency" text NOT NULL,
	"due_day" integer,
	"note" text DEFAULT '' NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "state_deposit_schedules_state_year_uniq" UNIQUE("state_code","tax_year"),
	CONSTRAINT "state_deposit_schedules_state_code_check" CHECK ("state_deposit_schedules"."state_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "state_deposit_schedules_frequency_check" CHECK ("state_deposit_schedules"."frequency" IN ('monthly','quarterly'))
);
