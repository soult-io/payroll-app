CREATE TABLE "filing_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"filing_id" integer NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "filing_attachments" ADD CONSTRAINT "filing_attachments_filing_id_tax_filings_id_fk" FOREIGN KEY ("filing_id") REFERENCES "public"."tax_filings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "filing_attachments_filing_idx" ON "filing_attachments" USING btree ("filing_id");