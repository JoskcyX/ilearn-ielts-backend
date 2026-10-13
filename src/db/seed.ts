import "dotenv/config";
import { db } from "@/db";
import {
  organizations,
  users,
  studentProfiles,
  teacherProfiles,
  classes,
  classMembers,
  passages,
  questionGroups,
  questions,
  mockTests,
  mockTestSections,
  bandConversions,
} from "@/db/schema";
import { hashPassword } from "@/lib/password";

/**
 * Phase 1 seed data: one organization, one admin, one teacher, several
 * students, and a sample class with those students enrolled.
 *
 * All accounts use the password "password123" purely for local
 * development. This is demo content, not official IELTS material, and
 * is not something a production deploy should run against a real
 * database with real users.
 */
async function main() {
  const orgName = process.env.SEED_ORG_NAME ?? "ILEARN Spaces";

  console.log(`Seeding organization: ${orgName}`);
  const [org] = await db
    .insert(organizations)
    .values({
      name: orgName,
      contactEmail: "hello@demo-ielts.example",
    })
    .returning();

  const demoPasswordHash = await hashPassword("password123");

  const [admin] = await db
    .insert(users)
    .values({
      organizationId: org.id,
      email: "admin@demo-ielts.example",
      passwordHash: demoPasswordHash,
      role: "ADMIN",
      fullName: "Amara Okafor",
    })
    .returning();

  const [teacherUser] = await db
    .insert(users)
    .values({
      organizationId: org.id,
      email: "teacher@demo-ielts.example",
      passwordHash: demoPasswordHash,
      role: "TEACHER",
      fullName: "David Chen",
    })
    .returning();
  const [teacherProfile] = await db
    .insert(teacherProfiles)
    .values({ userId: teacherUser.id })
    .returning();

  const studentSeeds = [
    { email: "student1@demo-ielts.example", fullName: "Fatima Al-Sayed" },
    { email: "student2@demo-ielts.example", fullName: "James Okoro" },
    { email: "student3@demo-ielts.example", fullName: "Linh Nguyen" },
    { email: "student4@demo-ielts.example", fullName: "Priya Sharma" },
  ];

  const studentProfileIds: string[] = [];
  for (const seed of studentSeeds) {
    const [studentUser] = await db
      .insert(users)
      .values({
        organizationId: org.id,
        email: seed.email,
        passwordHash: demoPasswordHash,
        role: "STUDENT",
        fullName: seed.fullName,
      })
      .returning();
    const [profile] = await db
      .insert(studentProfiles)
      .values({ userId: studentUser.id })
      .returning();
    studentProfileIds.push(profile.id);
  }

  const [demoClass] = await db
    .insert(classes)
    .values({
      organizationId: org.id,
      name: "September IELTS Cohort",
      teacherId: teacherProfile.id,
    })
    .returning();

  for (const studentId of studentProfileIds) {
    await db.insert(classMembers).values({
      classId: demoClass.id,
      studentId,
    });
  }

  // --- Band conversion tables ----------------------------------------
  // Standard, publicly published IELTS Academic raw-score -> band tables
  // (out of 40), seeded as this organization's starting default. Admins
  // can add/remove rows for their own question bank from
  // /admin/band-conversions — nothing here is hardcoded into the scoring
  // logic itself.
  console.log("\nSeeding band conversion tables...");
  const READING_BANDS: Array<[number, number, number]> = [
    [39, 40, 9], [37, 38, 8.5], [35, 36, 8], [33, 34, 7.5], [30, 32, 7],
    [27, 29, 6.5], [23, 26, 6], [19, 22, 5.5], [15, 18, 5], [13, 14, 4.5],
    [10, 12, 4], [8, 9, 3.5], [6, 7, 3], [4, 5, 2.5], [0, 3, 1],
  ];
  const LISTENING_BANDS: Array<[number, number, number]> = [
    [39, 40, 9], [37, 38, 8.5], [35, 36, 8], [32, 34, 7.5], [30, 31, 7],
    [26, 29, 6.5], [23, 25, 6], [18, 22, 5.5], [16, 17, 5], [13, 15, 4.5],
    [11, 12, 4], [8, 10, 3.5], [6, 7, 3], [4, 5, 2.5], [0, 3, 1],
  ];
  await db.insert(bandConversions).values([
    ...READING_BANDS.map(([minRaw, maxRaw, band]) => ({
      organizationId: org.id,
      section: "READING" as const,
      testType: "ACADEMIC" as const,
      minRaw,
      maxRaw,
      bandX10: Math.round(band * 10),
    })),
    ...LISTENING_BANDS.map(([minRaw, maxRaw, band]) => ({
      organizationId: org.id,
      section: "LISTENING" as const,
      testType: "ACADEMIC" as const,
      minRaw,
      maxRaw,
      bandX10: Math.round(band * 10),
    })),
  ]);

  // --- Sample question bank content (§43) ---------------------------
  // A real, seeded Reading passage + question group + questions, and a
  // full mock test wired up for Reading, Writing, and Speaking. Listening
  // is intentionally left for the admin to complete via the Audio page:
  // an audio_asset needs a real uploaded file, and fabricating a fake
  // storage key here would violate the "no fake functionality" rule
  // (§42) — there'd be nothing playable behind it.
  console.log("\nSeeding sample question bank content...");

  const [samplePassage] = await db
    .insert(passages)
    .values({
      organizationId: org.id,
      title: "The History of Public Libraries",
      testType: "ACADEMIC",
      status: "PUBLISHED",
      createdBy: admin.id,
      bodyHtml:
        "Public libraries as we know them today emerged in the 19th century, though their roots stretch back to antiquity. The Library of Alexandria, founded in the third century BCE, is often cited as the first great attempt to gather the world's knowledge in one place, though access was restricted to scholars rather than the general public.\n\nIt was not until the Public Libraries Act of 1850 in Britain that a legal framework for free, tax-funded libraries began to take shape. Reformers argued that universal access to books and information was essential for an informed citizenry and for social mobility. Andrew Carnegie, the Scottish-American industrialist, later funded the construction of over 2,500 libraries across the English-speaking world, believing that libraries offered the poor a path to self-improvement that charity alone could not provide.\n\nToday, public libraries face new questions about their purpose in a digital age, as they increasingly serve as community hubs, providing internet access, job-search assistance, and educational programming alongside their traditional lending services.",
    })
    .returning();

  const [readingGroup] = await db
    .insert(questionGroups)
    .values({
      organizationId: org.id,
      section: "READING",
      testType: "ACADEMIC",
      part: 1,
      instructions:
        "Questions 1-3: Do the following statements agree with the information given in the passage? Write TRUE, FALSE, or NOT GIVEN.",
      passageId: samplePassage.id,
      status: "PUBLISHED",
      createdBy: admin.id,
    })
    .returning();

  await db.insert(questions).values([
    {
      questionGroupId: readingGroup.id,
      questionType: "TRUE_FALSE_NOT_GIVEN",
      questionText: "The Library of Alexandria was open to the general public.",
      orderIndex: 0,
      skill: "True/False/Not Given",
      correctAnswer: { correctValue: "FALSE" },
      status: "PUBLISHED",
    },
    {
      questionGroupId: readingGroup.id,
      questionType: "TRUE_FALSE_NOT_GIVEN",
      questionText:
        "The Public Libraries Act of 1850 was passed in the United States.",
      orderIndex: 1,
      skill: "True/False/Not Given",
      correctAnswer: { correctValue: "FALSE" },
      status: "PUBLISHED",
    },
    {
      questionGroupId: readingGroup.id,
      questionType: "SHORT_ANSWER",
      questionText:
        "How many libraries did Andrew Carnegie fund the construction of? Write NO MORE THAN THREE WORDS.",
      orderIndex: 2,
      skill: "Short answer",
      correctAnswer: {
        acceptableAnswers: ["over 2,500", "2,500", "more than 2,500"],
        maxWords: 3,
      },
      status: "PUBLISHED",
    },
  ]);

  const [sampleMock] = await db
    .insert(mockTests)
    .values({
      organizationId: org.id,
      title: "Academic Mock Test 1",
      testType: "ACADEMIC",
      status: "DRAFT",
      createdBy: admin.id,
    })
    .returning();

  await db.insert(mockTestSections).values([
    {
      mockTestId: sampleMock.id,
      section: "READING",
      orderIndex: 0,
      timeLimitSec: 60 * 60,
      questionGroupIds: [readingGroup.id],
    },
    {
      mockTestId: sampleMock.id,
      section: "WRITING",
      orderIndex: 1,
      timeLimitSec: 60 * 60,
      writingTasks: [
        {
          taskNumber: 1,
          prompt:
            "The chart below shows the percentage of households with internet access in four countries between 2000 and 2020. Summarise the information by selecting and reporting the main features, and make comparisons where relevant.",
        },
        {
          taskNumber: 2,
          prompt:
            "Some people believe that public libraries are no longer necessary in the digital age. To what extent do you agree or disagree?",
        },
      ],
    },
    {
      mockTestId: sampleMock.id,
      section: "SPEAKING",
      orderIndex: 2,
      timeLimitSec: 15 * 60,
      speakingParts: [
        { part: 1 },
        {
          part: 2,
          cueCardTopic: "Describe a book that had a strong impact on you.",
          cueCardPoints: [
            "what the book was",
            "when you read it",
            "what it was about",
            "and explain why it had a strong impact on you",
          ],
          prepSeconds: 60,
          speakSeconds: 120,
        },
        { part: 3 },
      ],
    },
  ]);

  console.log(
    `Created sample mock test "${sampleMock.title}" (Reading + Writing + Speaking configured; add a Listening section via the Audio page, then publish).`
  );

  console.log("\nSeed complete. Demo accounts (password: password123):");
  console.log(`  Admin:   ${admin.email}`);
  console.log(`  Teacher: ${teacherUser.email}`);
  studentSeeds.forEach((s) => console.log(`  Student: ${s.email}`));
  console.log(`\nClass "${demoClass.name}" created with ${studentSeeds.length} students.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
