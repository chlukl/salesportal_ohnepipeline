CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"lead_id" text NOT NULL,
	"call_session_id" uuid,
	"booking_id" uuid,
	"transcript_id" uuid,
	"owner_user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"model" text,
	"result" jsonb,
	"usage" jsonb,
	"change_set_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"field" text,
	"old_value" jsonb,
	"new_value" jsonb,
	"change_set_id" uuid,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_ref" text NOT NULL,
	"lead_id" text NOT NULL,
	"lead_name" text,
	"company_name" text,
	"call_session_id" uuid,
	"sales_user_id" uuid,
	"specialist_user_id" uuid,
	"extra_call" boolean DEFAULT false NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"origin" text DEFAULT 'coldcall' NOT NULL,
	"event_id" text,
	"ical_uid" text,
	"blocker_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"briefing_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"needs_preparation" boolean DEFAULT false NOT NULL,
	"preparation_note" text,
	"briefing_status" text DEFAULT 'open' NOT NULL,
	"briefing_mail_sent_at" timestamp with time zone,
	"external_attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text NOT NULL,
	"body" text,
	"crm_booking_id" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"lead_id" text,
	"lead_name" text,
	"company_name" text,
	"phone_e164" text,
	"phone_display" text,
	"direction" text DEFAULT 'outbound' NOT NULL,
	"category" text DEFAULT 'outbound' NOT NULL,
	"status" text DEFAULT 'dialing' NOT NULL,
	"reason" text,
	"dialed_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_sec" integer,
	"duration_source" text,
	"vera_enabled" boolean DEFAULT true NOT NULL,
	"transcript_ref" text,
	"note_draft" text,
	"note_saved_at" timestamp with time zone,
	"result_group" text,
	"change_set_id" uuid,
	"crm_phonecall_id" text,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" text NOT NULL,
	"call_session_id" uuid,
	"kind" text NOT NULL,
	"rule_key" text,
	"rule_version" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"activities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state_changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lead_creates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"base_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pushed_at" timestamp with time zone,
	"pushed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mock_calendar_events" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox" text NOT NULL,
	"subject" text NOT NULL,
	"body" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"show_as" text DEFAULT 'busy' NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_cancelled" boolean DEFAULT false NOT NULL,
	"organizer" text,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extended_properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ical_uid" text,
	"is_online_meeting" boolean DEFAULT false NOT NULL,
	"online_join_url" text,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"last_modified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock_crm_accounts" (
	"accountid" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"websiteurl" text,
	"domain" text,
	"telephone1" text,
	"address1_city" text,
	"address1_postalcode" text,
	"address1_stateorprovince" text,
	"numberofemployees" integer,
	"industry" text,
	"ownerid" text,
	"is_customer" boolean DEFAULT false NOT NULL,
	"createdon" timestamp with time zone DEFAULT now() NOT NULL,
	"modifiedon" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock_crm_activities" (
	"activityid" text PRIMARY KEY NOT NULL,
	"activitytype" text NOT NULL,
	"regarding_lead_id" text,
	"regarding_account_id" text,
	"subject" text,
	"description" text,
	"direction" text,
	"ownerid" text,
	"from_text" text,
	"to_text" text,
	"phonenumber" text,
	"actualstart" timestamp with time zone,
	"actualend" timestamp with time zone,
	"duration_sec" integer,
	"scheduledstart" timestamp with time zone,
	"scheduledend" timestamp with time zone,
	"statecode" integer DEFAULT 1 NOT NULL,
	"kls_anrufergebnis" integer,
	"kls_interesse" integer,
	"kls_transkript_link" text,
	"is_campaign" boolean DEFAULT false NOT NULL,
	"campaign_name" text,
	"campaign_step" integer,
	"campaign_sender_name" text,
	"campaign_sender_email" text,
	"campaign_use_case_ids" jsonb,
	"campaign_reactions" jsonb,
	"createdon" timestamp with time zone DEFAULT now() NOT NULL,
	"modifiedon" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock_crm_contacts" (
	"contactid" text PRIMARY KEY NOT NULL,
	"parentcustomerid" text,
	"firstname" text,
	"lastname" text,
	"jobtitle" text,
	"emailaddress1" text,
	"telephone1" text,
	"mobilephone" text,
	"domain" text,
	"createdon" timestamp with time zone DEFAULT now() NOT NULL,
	"modifiedon" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock_crm_leads" (
	"leadid" text PRIMARY KEY NOT NULL,
	"companyname" text NOT NULL,
	"firstname" text,
	"lastname" text,
	"jobtitle" text,
	"emailaddress1" text,
	"telephone1" text,
	"mobilephone" text,
	"websiteurl" text,
	"domain" text,
	"numberofemployees" integer,
	"kls_industry" text,
	"kls_custom_industry" text,
	"kls_leadscore" integer,
	"kls_ki_bewertung" text,
	"kls_callstatus" integer,
	"kls_rating_category" integer,
	"statecode" integer DEFAULT 0 NOT NULL,
	"statuscode" integer DEFAULT 1 NOT NULL,
	"ownerid" text,
	"subject" text,
	"leadsourcecode" integer,
	"kls_lead_support" integer,
	"kls_interests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decisionmaker" boolean,
	"donotphone" boolean DEFAULT false NOT NULL,
	"donotemail" boolean DEFAULT false NOT NULL,
	"donotbulkemail" boolean DEFAULT false NOT NULL,
	"kls_competitor" boolean,
	"kls_salutation" integer,
	"address1_postalcode" text,
	"address1_city" text,
	"address1_stateorprovince" text,
	"parentaccountid" text,
	"org_type" text,
	"campaign_name" text,
	"campaign_joined_at" timestamp with time zone,
	"createdon" timestamp with time zone DEFAULT now() NOT NULL,
	"modifiedon" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock_crm_tasks" (
	"activityid" text PRIMARY KEY NOT NULL,
	"regarding_lead_id" text,
	"subject" text NOT NULL,
	"description" text,
	"scheduledend" timestamp with time zone,
	"ownerid" text,
	"statecode" integer DEFAULT 0 NOT NULL,
	"task_type" text DEFAULT 'follow_up' NOT NULL,
	"createdon" timestamp with time zone DEFAULT now() NOT NULL,
	"modifiedon" timestamp with time zone DEFAULT now() NOT NULL,
	"completedon" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mock_crm_users" (
	"id" text PRIMARY KEY NOT NULL,
	"fullname" text NOT NULL,
	"email" text NOT NULL,
	"title" text
);
--> statement-breakpoint
CREATE TABLE "mock_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_user_id" uuid,
	"from_email" text NOT NULL,
	"to" jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"original_to" jsonb,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"related_lead_id" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"entity" text,
	"entity_id" text,
	"severity" text DEFAULT 'info' NOT NULL,
	"read_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "objections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"answer" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "result_group_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"label" text NOT NULL,
	"definition" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_filters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"name" text NOT NULL,
	"filter" jsonb NOT NULL,
	"columns" jsonb,
	"sort" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"csrf_token" text NOT NULL,
	"view_as_role" text,
	"auth_method" text NOT NULL,
	"tokens_enc" text,
	"token_expires_at" timestamp with time zone,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_session_id" uuid,
	"lead_id" text,
	"source" text NOT NULL,
	"external_ref" text,
	"language" text,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_sec" integer,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_after" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_id_role_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"entra_oid" text,
	"crm_user_id" text,
	"phone_e164" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_filters" ADD CONSTRAINT "saved_filters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analyses_status_owner_idx" ON "analyses" USING btree ("status","owner_user_id");--> statement-breakpoint
CREATE INDEX "analyses_lead_idx" ON "analyses" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_change_set_idx" ON "audit_log" USING btree ("change_set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_ref_uq" ON "bookings" USING btree ("booking_ref");--> statement-breakpoint
CREATE INDEX "bookings_start_idx" ON "bookings" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX "bookings_lead_idx" ON "bookings" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "call_sessions_user_idx" ON "call_sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "call_sessions_lead_idx" ON "call_sessions" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "call_sessions_phone_idx" ON "call_sessions" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "change_sets_lead_idx" ON "change_sets" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "change_sets_status_idx" ON "change_sets" USING btree ("status","created_by");--> statement-breakpoint
CREATE INDEX "change_sets_call_idx" ON "change_sets" USING btree ("call_session_id");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uq" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "mock_calendar_mailbox_idx" ON "mock_calendar_events" USING btree ("mailbox","start_at");--> statement-breakpoint
CREATE INDEX "mock_calendar_modified_idx" ON "mock_calendar_events" USING btree ("last_modified");--> statement-breakpoint
CREATE INDEX "mock_crm_activities_lead_idx" ON "mock_crm_activities" USING btree ("regarding_lead_id");--> statement-breakpoint
CREATE INDEX "mock_crm_activities_type_owner_idx" ON "mock_crm_activities" USING btree ("activitytype","ownerid");--> statement-breakpoint
CREATE INDEX "mock_crm_contacts_domain_idx" ON "mock_crm_contacts" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "mock_crm_leads_domain_idx" ON "mock_crm_leads" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "mock_crm_leads_owner_idx" ON "mock_crm_leads" USING btree ("ownerid");--> statement-breakpoint
CREATE INDEX "mock_crm_tasks_owner_idx" ON "mock_crm_tasks" USING btree ("ownerid","statecode");--> statement-breakpoint
CREATE INDEX "mock_crm_tasks_lead_idx" ON "mock_crm_tasks" USING btree ("regarding_lead_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","done_at");--> statement-breakpoint
CREATE UNIQUE INDEX "objections_key_uq" ON "objections" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "result_group_rules_key_version_uq" ON "result_group_rules" USING btree ("key","version");--> statement-breakpoint
CREATE INDEX "saved_filters_user_scope_idx" ON "saved_filters" USING btree ("user_id","scope");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_key_uq" ON "templates" USING btree ("key");--> statement-breakpoint
CREATE INDEX "transcripts_delete_after_idx" ON "transcripts" USING btree ("delete_after");--> statement-breakpoint
CREATE INDEX "transcripts_call_idx" ON "transcripts" USING btree ("call_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_entra_oid_uq" ON "users" USING btree ("entra_oid");