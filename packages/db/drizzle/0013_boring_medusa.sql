CREATE TABLE "w2_delivery_consents" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"disclosure_version" text NOT NULL,
	"consented_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "w2_delivery_consents_employee_uniq" UNIQUE("employee_id")
);
--> statement-breakpoint
ALTER TABLE "w2_delivery_consents" ADD CONSTRAINT "w2_delivery_consents_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;