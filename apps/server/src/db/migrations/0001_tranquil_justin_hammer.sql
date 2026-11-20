CREATE TABLE "pendenz_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"done_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e164" text NOT NULL,
	"lead_id" text NOT NULL,
	"lead_name" text,
	"company_name" text,
	"assigned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pendenz_states" ADD CONSTRAINT "pendenz_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pendenz_states_user_item_uq" ON "pendenz_states" USING btree ("user_id","item_key");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_assignments_phone_uq" ON "phone_assignments" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "phone_assignments_lead_idx" ON "phone_assignments" USING btree ("lead_id");