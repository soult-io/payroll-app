CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tax_deposits" (
	"id" serial PRIMARY KEY NOT NULL,
	"jurisdiction" text DEFAULT 'federal' NOT NULL,
	"period_start" date NOT NULL,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"due_date" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"deposited_on" date,
	"eftps_confirmation" text,
	"reminders_sent" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "tax_deposits_jurisdiction_period_uniq" UNIQUE("jurisdiction","period_start"),
	CONSTRAINT "tax_deposits_status_check" CHECK ("tax_deposits"."status" IN ('pending','deposited','overdue'))
);
