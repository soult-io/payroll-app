CREATE TABLE "setup_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "setup_tokens_purpose_check" CHECK ("setup_tokens"."purpose" IN ('invite','reset'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "setup_tokens_token_hash_uniq" ON "setup_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "setup_tokens_user_id_idx" ON "setup_tokens" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "setup_tokens" ADD CONSTRAINT "setup_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
