CREATE TABLE "deposit_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"deposit_id" integer NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "deposit_attachments" ADD CONSTRAINT "deposit_attachments_deposit_id_tax_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."tax_deposits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deposit_attachments_deposit_idx" ON "deposit_attachments" USING btree ("deposit_id");