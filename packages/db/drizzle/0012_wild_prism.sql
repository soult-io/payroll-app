CREATE TABLE "tax_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"filing_id" integer NOT NULL,
	"kind" text NOT NULL,
	"notice_date" date,
	"amount_due" numeric(12, 2) DEFAULT '0' NOT NULL,
	"abated_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(12, 2) DEFAULT '0' NOT NULL,
	"paid_on" date,
	"eftps_confirmation" text,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tax_filings" (
	"id" serial PRIMARY KEY NOT NULL,
	"form_type" text NOT NULL,
	"year" integer NOT NULL,
	"quarter" integer DEFAULT 0 NOT NULL,
	"due_date" date NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"worksheet" jsonb,
	"worksheet_hash" text,
	"fractions_of_cents" numeric(12, 2) DEFAULT '0' NOT NULL,
	"filed_on" date,
	"filing_method" text,
	"filing_reference" text,
	"reminders_sent" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "tax_filings_form_year_quarter_uniq" UNIQUE("form_type","year","quarter"),
	CONSTRAINT "tax_filings_form_type_check" CHECK ("tax_filings"."form_type" IN ('941','940','w2_w3')),
	CONSTRAINT "tax_filings_quarter_check" CHECK ("tax_filings"."quarter" BETWEEN 0 AND 4),
	CONSTRAINT "tax_filings_status_check" CHECK ("tax_filings"."status" IN ('not_started','ready','filed'))
);
--> statement-breakpoint
ALTER TABLE "tax_adjustments" ADD CONSTRAINT "tax_adjustments_filing_id_tax_filings_id_fk" FOREIGN KEY ("filing_id") REFERENCES "public"."tax_filings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tax_adjustments_filing_idx" ON "tax_adjustments" USING btree ("filing_id");