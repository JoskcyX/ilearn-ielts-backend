CREATE TYPE "public"."ai_assessment_status" AS ENUM('PENDING', 'COMPLETE', 'FAILED');--> statement-breakpoint
CREATE TABLE "ai_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"section" "section" NOT NULL,
	"task_number" integer DEFAULT 0 NOT NULL,
	"status" "ai_assessment_status" DEFAULT 'PENDING' NOT NULL,
	"criteria_scores" jsonb,
	"overall_band_x10" integer,
	"feedback" text,
	"transcript" text,
	"error_message" text,
	"raw_model_response" jsonb,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "speaking_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"part" integer NOT NULL,
	"storage_key" text NOT NULL,
	"duration_sec" integer,
	"transcript" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_assessments" ADD CONSTRAINT "ai_assessments_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speaking_recordings" ADD CONSTRAINT "speaking_recordings_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_assessments_attempt_section_task_unique_idx" ON "ai_assessments" USING btree ("attempt_id","section","task_number");--> statement-breakpoint
CREATE UNIQUE INDEX "speaking_recordings_attempt_part_unique_idx" ON "speaking_recordings" USING btree ("attempt_id","part");