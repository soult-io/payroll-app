CREATE TABLE "contractor_details" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"tax_status" text NOT NULL,
	"entity_type" text NOT NULL,
	"residence_country" text,
	"tin" text,
	"tax_form" text NOT NULL,
	"form_collected_at" date,
	"form_expires_at" date,
	"backup_withholding" boolean DEFAULT false NOT NULL,
	"services_location" text DEFAULT 'foreign' NOT NULL,
	"us_days_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "contractor_details_employee_uniq" UNIQUE("employee_id"),
	CONSTRAINT "contractor_details_tax_status_check" CHECK ("contractor_details"."tax_status" IN ('us_person','nonresident')),
	CONSTRAINT "contractor_details_entity_type_check" CHECK ("contractor_details"."entity_type" IN ('individual','entity')),
	CONSTRAINT "contractor_details_tax_form_check" CHECK ("contractor_details"."tax_form" IN ('w9','w8ben','w8ben_e','w8eci')),
	CONSTRAINT "contractor_details_services_location_check" CHECK ("contractor_details"."services_location" IN ('foreign','us','mixed'))
);
--> statement-breakpoint
CREATE TABLE "contractor_invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"invoice_ref" text,
	"description" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"invoice_date" date NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"submitted_by" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "contractor_invoices_amount_check" CHECK ("contractor_invoices"."amount" > 0),
	CONSTRAINT "contractor_invoices_status_check" CHECK ("contractor_invoices"."status" IN ('submitted','approved','rejected','paid','void'))
);
--> statement-breakpoint
CREATE TABLE "contractor_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"pay_date" date NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"exchange_rate" numeric(12, 6),
	"method" text NOT NULL,
	"backup_withheld" numeric(12, 2) DEFAULT '0' NOT NULL,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "contractor_payments_invoice_uniq" UNIQUE("invoice_id"),
	CONSTRAINT "contractor_payments_method_check" CHECK ("contractor_payments"."method" IN ('ach','check','wire','card','third_party_network'))
);
--> statement-breakpoint
CREATE TABLE "contractor_reporting_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"tax_year" integer NOT NULL,
	"nec_threshold" numeric(12, 2) NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "contractor_reporting_config_year_uniq" UNIQUE("tax_year")
);
--> statement-breakpoint
ALTER TABLE "contractor_details" ADD CONSTRAINT "contractor_details_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractor_invoices" ADD CONSTRAINT "contractor_invoices_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractor_payments" ADD CONSTRAINT "contractor_payments_invoice_id_contractor_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."contractor_invoices"("id") ON DELETE no action ON UPDATE no action;