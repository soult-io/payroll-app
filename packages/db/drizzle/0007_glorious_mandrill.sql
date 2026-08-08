CREATE TABLE "legacy_migration_map" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity" text NOT NULL,
	"source_id" text NOT NULL,
	"target_id" text NOT NULL,
	"migrated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "legacy_migration_map_entity_source_uniq" UNIQUE("entity","source_id")
);
