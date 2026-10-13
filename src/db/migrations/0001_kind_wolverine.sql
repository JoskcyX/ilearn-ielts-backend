CREATE TYPE "public"."content_status" AS ENUM('DRAFT', 'PUBLISHED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."question_type" AS ENUM('MULTIPLE_CHOICE', 'MATCHING', 'MATCHING_HEADINGS', 'FORM_COMPLETION', 'NOTE_COMPLETION', 'TABLE_COMPLETION', 'FLOW_CHART_COMPLETION', 'SUMMARY_COMPLETION', 'SENTENCE_COMPLETION', 'SHORT_ANSWER', 'TRUE_FALSE_NOT_GIVEN', 'YES_NO_NOT_GIVEN', 'DIAGRAM_LABELING', 'MAP_LABELING');--> statement-breakpoint
CREATE TYPE "public"."section" AS ENUM('LISTENING', 'READING', 'WRITING', 'SPEAKING');--> statement-breakpoint
CREATE TYPE "public"."test_type" AS ENUM('ACADEMIC', 'GENERAL_TRAINING');--> statement-breakpoint
CREATE TABLE "audio_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"storage_key" text NOT NULL,
	"duration_sec" integer,
	"transcript" text,
	"status" "content_status" DEFAULT 'DRAFT' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock_test_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mock_test_id" uuid NOT NULL,
	"section" "section" NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"time_limit_sec" integer NOT NULL,
	"question_group_ids" jsonb,
	"writing_tasks" jsonb,
	"speaking_parts" jsonb
);
--> statement-breakpoint
CREATE TABLE "mock_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"test_type" "test_type" NOT NULL,
	"status" "content_status" DEFAULT 'DRAFT' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body_html" text NOT NULL,
	"test_type" "test_type" NOT NULL,
	"status" "content_status" DEFAULT 'DRAFT' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"section" "section" NOT NULL,
	"test_type" "test_type" NOT NULL,
	"part" integer NOT NULL,
	"instructions" text NOT NULL,
	"passage_id" uuid,
	"audio_id" uuid,
	"status" "content_status" DEFAULT 'DRAFT' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_group_id" uuid NOT NULL,
	"question_type" "question_type" NOT NULL,
	"question_text" text NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"difficulty" text,
	"skill" text,
	"marks" integer DEFAULT 1 NOT NULL,
	"correct_answer" jsonb NOT NULL,
	"explanation" text,
	"status" "content_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audio_assets" ADD CONSTRAINT "audio_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_assets" ADD CONSTRAINT "audio_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_test_sections" ADD CONSTRAINT "mock_test_sections_mock_test_id_mock_tests_id_fk" FOREIGN KEY ("mock_test_id") REFERENCES "public"."mock_tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_tests" ADD CONSTRAINT "mock_tests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_tests" ADD CONSTRAINT "mock_tests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passages" ADD CONSTRAINT "passages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passages" ADD CONSTRAINT "passages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_groups" ADD CONSTRAINT "question_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_groups" ADD CONSTRAINT "question_groups_passage_id_passages_id_fk" FOREIGN KEY ("passage_id") REFERENCES "public"."passages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_groups" ADD CONSTRAINT "question_groups_audio_id_audio_assets_id_fk" FOREIGN KEY ("audio_id") REFERENCES "public"."audio_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_groups" ADD CONSTRAINT "question_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_question_group_id_question_groups_id_fk" FOREIGN KEY ("question_group_id") REFERENCES "public"."question_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audio_assets_org_status_idx" ON "audio_assets" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "mock_test_sections_mock_test_idx" ON "mock_test_sections" USING btree ("mock_test_id");--> statement-breakpoint
CREATE INDEX "mock_tests_org_status_idx" ON "mock_tests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "passages_org_status_idx" ON "passages" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "question_groups_section_type_part_idx" ON "question_groups" USING btree ("section","test_type","part");--> statement-breakpoint
CREATE INDEX "question_groups_org_status_idx" ON "question_groups" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "questions_group_order_idx" ON "questions" USING btree ("question_group_id","order_index");--> statement-breakpoint
CREATE INDEX "questions_skill_idx" ON "questions" USING btree ("skill");