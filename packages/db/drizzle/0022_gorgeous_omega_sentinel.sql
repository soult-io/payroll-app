ALTER TABLE "tax_deposits" DROP CONSTRAINT "tax_deposits_jurisdiction_period_uniq";--> statement-breakpoint
ALTER TABLE "tax_deposits" DROP CONSTRAINT "tax_deposits_status_check";--> statement-breakpoint
ALTER TABLE "tax_deposits" ADD COLUMN "period_kind" text DEFAULT 'month' NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_deposits" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_deposits_live_period_uniq" ON "tax_deposits" USING btree ("jurisdiction","period_start","period_kind") WHERE "tax_deposits"."status" <> 'superseded';--> statement-breakpoint
ALTER TABLE "tax_deposits" ADD CONSTRAINT "tax_deposits_period_kind_check" CHECK ("tax_deposits"."period_kind" IN ('month','quarter'));--> statement-breakpoint
ALTER TABLE "tax_deposits" ADD CONSTRAINT "tax_deposits_quarter_start_check" CHECK ("tax_deposits"."period_kind" = 'month' OR extract(month from "tax_deposits"."period_start") IN (1,4,7,10));--> statement-breakpoint
ALTER TABLE "tax_deposits" ADD CONSTRAINT "tax_deposits_federal_month_check" CHECK ("tax_deposits"."jurisdiction" <> 'federal' OR "tax_deposits"."period_kind" = 'month');--> statement-breakpoint
ALTER TABLE "tax_deposits" ADD CONSTRAINT "tax_deposits_superseded_check" CHECK (("tax_deposits"."status" = 'superseded') = ("tax_deposits"."superseded_at" IS NOT NULL) AND ("tax_deposits"."status" <> 'superseded' OR "tax_deposits"."deposited_on" IS NULL));--> statement-breakpoint
ALTER TABLE "tax_deposits" ADD CONSTRAINT "tax_deposits_amount_nonneg_check" CHECK ("tax_deposits"."amount" >= 0);--> statement-breakpoint
ALTER TABLE "tax_deposits" ADD CONSTRAINT "tax_deposits_status_check" CHECK ("tax_deposits"."status" IN ('pending','deposited','overdue','superseded'));