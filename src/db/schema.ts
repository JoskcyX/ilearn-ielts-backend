import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  uuid,
  jsonb,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import type { Block } from "@/lib/validations/blocks";

/**
 * PHASE 1 SCHEMA
 * ---------------------------------------------------------------------
 * This covers identity, roles, organizations, and the class/cohort
 * structure — enough for authentication, RBAC, and the three dashboard
 * shells.
 *
 * Deliberately NOT included yet (added in their respective phases so the
 * schema grows alongside the features that need it, per the phased build
 * plan): questions, passages, audio, mock tests, exam attempts, answers,
 * writing/speaking submissions, AI assessments, scores, assignments.
 * See ARCHITECTURE.md for the full target schema.
 */

export const roleEnum = pgEnum("role", ["STUDENT", "TEACHER", "ADMIN"]);
export const contentStatusEnum = pgEnum("content_status", [
  "DRAFT",
  "PUBLISHED",
  "ARCHIVED",
]);
export const testTypeEnum = pgEnum("test_type", ["ACADEMIC", "GENERAL_TRAINING"]);
export const sectionEnum = pgEnum("section", [
  "LISTENING",
  "READING",
  "WRITING",
  "SPEAKING",
]);
/**
 * The full set of IELTS-style question formats from the spec. The DB enum
 * covers all of them since it's just a value set; the admin editor UI
 * (components/admin/questions/editors) currently implements a working
 * editor for a representative subset (see ARCHITECTURE notes in that
 * folder) and is built as a registry so the remaining types are additive,
 * not a rewrite.
 */
export const questionTypeEnum = pgEnum("question_type", [
  "MULTIPLE_CHOICE",
  "MATCHING",
  "MATCHING_HEADINGS",
  "FORM_COMPLETION",
  "NOTE_COMPLETION",
  "TABLE_COMPLETION",
  "FLOW_CHART_COMPLETION",
  "SUMMARY_COMPLETION",
  "SENTENCE_COMPLETION",
  "SHORT_ANSWER",
  "TRUE_FALSE_NOT_GIVEN",
  "YES_NO_NOT_GIVEN",
  "DIAGRAM_LABELING",
  "MAP_LABELING",
]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  logoUrl: text("logo_url"),
  primaryColor: text("primary_color"),
  contactEmail: text("contact_email"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: roleEnum("role").notNull(),
    fullName: text("full_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("users_email_unique_idx").on(table.email),
    index("users_org_role_idx").on(table.organizationId, table.role),
  ]
);

export const studentProfiles = pgTable("student_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" })
    .unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const teacherProfiles = pgTable("teacher_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" })
    .unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const classes = pgTable(
  "classes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => teacherProfiles.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("classes_org_idx").on(table.organizationId)]
);

export const classMembers = pgTable(
  "class_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("class_members_class_student_unique_idx").on(
      table.classId,
      table.studentId
    ),
    index("class_members_student_idx").on(table.studentId),
  ]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_logs_user_created_idx").on(table.userId, table.createdAt),
  ]
);

/**
 * PHASE 2 ADDITIONS
 * ---------------------------------------------------------------------
 * Question bank (passages, audio, question groups, questions) and the
 * mock test blueprint (mock_tests -> mock_test_sections -> question
 * groups). Still deferred to later phases: exam attempts/answers,
 * writing/speaking submissions, AI assessments, scores, assignments.
 */

export const passages = pgTable(
  "passages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    bodyHtml: text("body_html").notNull(),
    testType: testTypeEnum("test_type").notNull(),
    status: contentStatusEnum("status").notNull().default("DRAFT"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("passages_org_status_idx").on(table.organizationId, table.status),
  ]
);

export const audioAssets = pgTable(
  "audio_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    // Storage-adapter-relative key, never a public URL directly — see
    // lib/storage.ts. Swapping the adapter (local disk -> R2/S3 in Phase
    // 6) does not require changing this column.
    storageKey: text("storage_key").notNull(),
    durationSec: integer("duration_sec"),
    transcript: text("transcript"), // teacher/admin only, never sent to students pre-submission
    status: contentStatusEnum("status").notNull().default("DRAFT"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audio_assets_org_status_idx").on(table.organizationId, table.status),
  ]
);

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    altText: text("alt_text"),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("media_assets_org_idx").on(table.organizationId)]
);

export const questionGroups = pgTable(
  "question_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    section: sectionEnum("section").notNull(),
    testType: testTypeEnum("test_type").notNull(),
    part: integer("part").notNull(), // Listening Part 1-4, Reading Section 1-3
    title: text("title"),
    instructions: text("instructions").notNull(),
    // Ordered stimulus blocks (see lib/validations/blocks.ts). No answers.
    blocks: jsonb("blocks").$type<Block[]>().notNull().default([]),
    passageId: uuid("passage_id").references(() => passages.id, {
      onDelete: "set null",
    }),
    audioId: uuid("audio_id").references(() => audioAssets.id, {
      onDelete: "set null",
    }),
    status: contentStatusEnum("status").notNull().default("DRAFT"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("question_groups_section_type_part_idx").on(
      table.section,
      table.testType,
      table.part
    ),
    index("question_groups_org_status_idx").on(
      table.organizationId,
      table.status
    ),
  ]
);

export const questions = pgTable(
  "questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionGroupId: uuid("question_group_id")
      .notNull()
      .references(() => questionGroups.id, { onDelete: "cascade" }),
    questionType: questionTypeEnum("question_type").notNull(),
    questionText: text("question_text").notNull(),
    orderIndex: integer("order_index").notNull().default(0),
    difficulty: text("difficulty"),
    skill: text("skill"), // free-text tag used for weak-area analytics later
    marks: integer("marks").notNull().default(1),
    // Shape varies per questionType — validated at the API boundary by a
    // per-type zod schema (lib/validations/questions.ts), not by the DB.
    correctAnswer: jsonb("correct_answer").notNull(),
    explanation: text("explanation"),
    status: contentStatusEnum("status").notNull().default("DRAFT"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("questions_group_order_idx").on(
      table.questionGroupId,
      table.orderIndex
    ),
    index("questions_skill_idx").on(table.skill),
  ]
);

export const mockTests = pgTable(
  "mock_tests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    testType: testTypeEnum("test_type").notNull(),
    status: contentStatusEnum("status").notNull().default("DRAFT"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("mock_tests_org_status_idx").on(table.organizationId, table.status),
  ]
);

export const mockTestSections = pgTable(
  "mock_test_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mockTestId: uuid("mock_test_id")
      .notNull()
      .references(() => mockTests.id, { onDelete: "cascade" }),
    section: sectionEnum("section").notNull(),
    orderIndex: integer("order_index").notNull().default(0),
    timeLimitSec: integer("time_limit_sec").notNull(),
    // Ordered list of question_groups.id included in this section.
    // Listening/Reading only.
    questionGroupIds: jsonb("question_group_ids").$type<string[]>(),
    // Writing/Speaking task configuration. Deliberately loose (jsonb) —
    // the authoring UI for these is minimal until Phases 5/6 build the
    // full Writing/Speaking engines; this shape can grow without a
    // migration.
    writingTasks: jsonb("writing_tasks"),
    speakingParts: jsonb("speaking_parts"),
  },
  (table) => [
    index("mock_test_sections_mock_test_idx").on(table.mockTestId),
  ]
);



export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  classes: many(classes),
}));

export const usersRelations = relations(users, ({ one }) => ({
  organization: one(organizations, {
    fields: [users.organizationId],
    references: [organizations.id],
  }),
  studentProfile: one(studentProfiles, {
    fields: [users.id],
    references: [studentProfiles.userId],
  }),
  teacherProfile: one(teacherProfiles, {
    fields: [users.id],
    references: [teacherProfiles.userId],
  }),
}));

export const studentProfilesRelations = relations(
  studentProfiles,
  ({ one, many }) => ({
    user: one(users, {
      fields: [studentProfiles.userId],
      references: [users.id],
    }),
    classMemberships: many(classMembers),
  })
);

export const teacherProfilesRelations = relations(
  teacherProfiles,
  ({ one, many }) => ({
    user: one(users, {
      fields: [teacherProfiles.userId],
      references: [users.id],
    }),
    classes: many(classes),
  })
);

export const classesRelations = relations(classes, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [classes.organizationId],
    references: [organizations.id],
  }),
  teacher: one(teacherProfiles, {
    fields: [classes.teacherId],
    references: [teacherProfiles.id],
  }),
  members: many(classMembers),
}));

export const classMembersRelations = relations(classMembers, ({ one }) => ({
  class: one(classes, {
    fields: [classMembers.classId],
    references: [classes.id],
  }),
  student: one(studentProfiles, {
    fields: [classMembers.studentId],
    references: [studentProfiles.id],
  }),
}));

export const passagesRelations = relations(passages, ({ many }) => ({
  questionGroups: many(questionGroups),
}));

export const audioAssetsRelations = relations(audioAssets, ({ many }) => ({
  questionGroups: many(questionGroups),
}));

export const questionGroupsRelations = relations(
  questionGroups,
  ({ one, many }) => ({
    passage: one(passages, {
      fields: [questionGroups.passageId],
      references: [passages.id],
    }),
    audio: one(audioAssets, {
      fields: [questionGroups.audioId],
      references: [audioAssets.id],
    }),
    questions: many(questions),
  })
);

export const questionsRelations = relations(questions, ({ one }) => ({
  questionGroup: one(questionGroups, {
    fields: [questions.questionGroupId],
    references: [questionGroups.id],
  }),
}));

export const mockTestsRelations = relations(mockTests, ({ many }) => ({
  sections: many(mockTestSections),
}));

export const mockTestSectionsRelations = relations(
  mockTestSections,
  ({ one }) => ({
    mockTest: one(mockTests, {
      fields: [mockTestSections.mockTestId],
      references: [mockTests.id],
    }),
  })
);

/**
 * PHASE 3 ADDITIONS — the exam engine
 * ---------------------------------------------------------------------
 * A student starts an attempt directly against a PUBLISHED mock test in
 * their own organization. There is deliberately no class/cohort/assignment
 * table referenced anywhere below: practice-quiz-taking is intentionally
 * decoupled from class membership (per explicit product direction) — a
 * student signs up and can sit any published mock test in their org the
 * moment they want to. Class features (assignments, due dates, cohort
 * analytics) can layer on top of this later without changing this model.
 */
export const attemptStatusEnum = pgEnum("attempt_status", [
  "IN_PROGRESS",
  "SUBMITTED",
]);

export const attempts = pgTable(
  "attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    studentId: uuid("student_id")
      .notNull()
      .references(() => studentProfiles.id, { onDelete: "cascade" }),
    mockTestId: uuid("mock_test_id")
      .notNull()
      .references(() => mockTests.id, { onDelete: "restrict" }),
    status: attemptStatusEnum("status").notNull().default("IN_PROGRESS"),
    // Server-authoritative schedule: computed once at start from the
    // section time limits, as a cumulative deadline per section
    // ({ READING: <iso>, WRITING: <iso>, ... }). The client only ever
    // displays a countdown derived from this; it never sets the clock.
    sectionDeadlines: jsonb("section_deadlines")
      .$type<Record<string, string>>()
      .notNull(),
    currentSection: sectionEnum("current_section").notNull(),
    // Populated on submit. Each section key holds either
    // { raw, maxRaw, band } for auto-scored sections (Listening/Reading)
    // or { status: "pending_review" } for sections that need a human or
    // an AI assessment pass not yet wired up (Writing/Speaking) — never a
    // fabricated number (§42).
    scores: jsonb("scores").$type<Record<string, unknown>>(),
    overallBandX10: integer("overall_band_x10"), // band * 10, so 6.5 -> 65; null until every section has a real band
    // Writing task answers, keyed by task number as a string ("1", "2").
    // Not backed by `questions` rows (writing tasks are config on the
    // section, not question-bank rows), so they live here rather than in
    // attempt_responses.
    writingResponses: jsonb("writing_responses").$type<Record<string, string>>(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
  },
  (table) => [
    index("attempts_student_idx").on(table.studentId, table.startedAt),
    index("attempts_org_idx").on(table.organizationId, table.status),
  ]
);

export const attemptResponses = pgTable(
  "attempt_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    // Shape mirrors the question's answer-schema family (see
    // lib/validations/questions.ts): { selectedIndexes } for multiple
    // choice, { value } for true/false/yes-no and fill-blank types, or
    // { text } for Writing tasks.
    response: jsonb("response").notNull(),
    isCorrect: text("is_correct"), // "true" | "false" | null (null = not auto-gradable)
    marksAwarded: integer("marks_awarded"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("attempt_responses_attempt_question_unique_idx").on(
      table.attemptId,
      table.questionId
    ),
  ]
);

/**
 * Raw-score -> band lookup, per organization/testType/section. Seeded
 * with the publicly published IELTS Academic conversion bands as a
 * starting default; admins can add/edit rows for their own organization
 * without a code change (§ "configurable conversion tables").
 */
export const bandConversions = pgTable(
  "band_conversions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    section: sectionEnum("section").notNull(),
    testType: testTypeEnum("test_type").notNull(),
    minRaw: integer("min_raw").notNull(),
    maxRaw: integer("max_raw").notNull(),
    bandX10: integer("band_x10").notNull(), // band * 10, e.g. 6.5 -> 65
  },
  (table) => [
    index("band_conversions_lookup_idx").on(
      table.organizationId,
      table.section,
      table.testType
    ),
  ]
);

/**
 * PHASE 7 ADDITIONS — Speaking recordings + OpenAI-backed AI assessment
 * ---------------------------------------------------------------------
 * Speaking has no answer key to grade against, so a recording is captured
 * per cue-card part and, when OPENAI_API_KEY is configured, transcribed
 * and assessed. Writing already has real response text (writingResponses
 * above); this adds the assessment pass for it. Neither pipeline ever
 * fabricates a band when it isn't configured or a call fails (§42) — see
 * ai_assessments.status.
 */
export const speakingRecordings = pgTable(
  "speaking_recordings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    part: integer("part").notNull(),
    storageKey: text("storage_key").notNull(),
    durationSec: integer("duration_sec"),
    // Filled in by the Whisper transcription step at submit time, kept
    // here (per part) so a student/teacher can read what was actually
    // said, separately from the combined transcript used for assessment.
    transcript: text("transcript"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("speaking_recordings_attempt_part_unique_idx").on(
      table.attemptId,
      table.part
    ),
  ]
);

export const aiAssessmentStatusEnum = pgEnum("ai_assessment_status", [
  "PENDING",
  "COMPLETE",
  "FAILED",
]);

export const aiAssessments = pgTable(
  "ai_assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    section: sectionEnum("section").notNull(), // WRITING | SPEAKING
    // Writing: 1 or 2 (per task). Speaking: 0, meaning the whole section —
    // IELTS Speaking is marked holistically across all parts, not per part.
    taskNumber: integer("task_number").notNull().default(0),
    status: aiAssessmentStatusEnum("status").notNull().default("PENDING"),
    // Band x10 per criterion, e.g. { "taskResponse": 65, "coherenceCohesion": 70, ... }.
    criteriaScores: jsonb("criteria_scores").$type<Record<string, number>>(),
    overallBandX10: integer("overall_band_x10"),
    feedback: text("feedback"),
    // Speaking only: the combined transcript the assessment was run against.
    transcript: text("transcript"),
    errorMessage: text("error_message"),
    rawModelResponse: jsonb("raw_model_response"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("ai_assessments_attempt_section_task_unique_idx").on(
      table.attemptId,
      table.section,
      table.taskNumber
    ),
  ]
);

export const speakingRecordingsRelations = relations(
  speakingRecordings,
  ({ one }) => ({
    attempt: one(attempts, {
      fields: [speakingRecordings.attemptId],
      references: [attempts.id],
    }),
  })
);

export const aiAssessmentsRelations = relations(aiAssessments, ({ one }) => ({
  attempt: one(attempts, {
    fields: [aiAssessments.attemptId],
    references: [attempts.id],
  }),
}));

export const attemptsRelations = relations(attempts, ({ one, many }) => ({
  mockTest: one(mockTests, {
    fields: [attempts.mockTestId],
    references: [mockTests.id],
  }),
  student: one(studentProfiles, {
    fields: [attempts.studentId],
    references: [studentProfiles.id],
  }),
  responses: many(attemptResponses),
  speakingRecordings: many(speakingRecordings),
  aiAssessments: many(aiAssessments),
}));

export const attemptResponsesRelations = relations(
  attemptResponses,
  ({ one }) => ({
    attempt: one(attempts, {
      fields: [attemptResponses.attemptId],
      references: [attempts.id],
    }),
    question: one(questions, {
      fields: [attemptResponses.questionId],
      references: [questions.id],
    }),
  })
);
