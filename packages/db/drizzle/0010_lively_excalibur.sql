CREATE TABLE "contractor_recurring_invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"invoice_day" text DEFAULT 'last_day' NOT NULL,
	"invoice_day_of_month" integer,
	"pay_day_of_month" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"last_generated_period" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "contractor_recurring_invoices_amount_check" CHECK ("contractor_recurring_invoices"."amount" > 0),
	CONSTRAINT "contractor_recurring_invoices_invoice_day_check" CHECK ("contractor_recurring_invoices"."invoice_day" IN ('last_day','fixed')),
	CONSTRAINT "contractor_recurring_invoices_invoice_day_of_month_check" CHECK ("contractor_recurring_invoices"."invoice_day_of_month" BETWEEN 1 AND 28),
	CONSTRAINT "contractor_recurring_invoices_pay_day_of_month_check" CHECK ("contractor_recurring_invoices"."pay_day_of_month" BETWEEN 1 AND 28)
);
--> statement-breakpoint
ALTER TABLE "contractor_invoices" ADD COLUMN "recurring_template_id" integer;--> statement-breakpoint
ALTER TABLE "contractor_invoices" ADD COLUMN "recurring_period" text;--> statement-breakpoint
ALTER TABLE "contractor_recurring_invoices" ADD CONSTRAINT "contractor_recurring_invoices_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractor_invoices" ADD CONSTRAINT "contractor_invoices_recurring_template_id_contractor_recurring_invoices_id_fk" FOREIGN KEY ("recurring_template_id") REFERENCES "public"."contractor_recurring_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contractor_invoices_recurring_period_uniq" ON "contractor_invoices" USING btree ("recurring_template_id","recurring_period") WHERE "contractor_invoices"."recurring_template_id" IS NOT NULL;