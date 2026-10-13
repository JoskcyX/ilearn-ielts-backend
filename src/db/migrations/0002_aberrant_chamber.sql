CREATE TYPE "public"."attempt_status" AS ENUM('IN_PROGRESS', 'SUBMITTED');--> statement-breakpoint
CREATE TABLE "attempt_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"response" jsonb NOT NULL,
	"is_correct" text,
	"marks_awarded" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"mock_test_id" uuid NOT NULL,
	"status" "attempt_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"section_deadlines" jsonb NOT NULL,
	"current_section" "section" NOT NULL,
	"scores" jsonb,
	"overall_band_x10" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "band_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"section" "section" NOT NULL,
	"test_type" "test_type" NOT NULL,
	"min_raw" integer NOT NULL,
	"max_raw" integer NOT NULL,
	"band_x10" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempt_responses" ADD CONSTRAINT "attempt_responses_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_responses" ADD CONSTRAINT "attempt_responses_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_mock_test_id_mock_tests_id_fk" FOREIGN KEY ("mock_test_id") REFERENCES "public"."mock_tests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "band_conversions" ADD CONSTRAINT "band_conversions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attempt_responses_attempt_question_unique_idx" ON "attempt_responses" USING btree ("attempt_id","question_id");--> statement-breakpoint
CREATE INDEX "attempts_student_idx" ON "attempts" USING btree ("student_id","started_at");--> statement-breakpoint
CREATE INDEX "attempts_org_idx" ON "attempts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "band_conversions_lookup_idx" ON "band_conversions" USING btree ("organization_id","section","test_type");