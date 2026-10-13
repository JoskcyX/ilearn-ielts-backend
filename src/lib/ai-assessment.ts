import { z } from "zod";
import { env } from "@/lib/env";

/**
 * OpenAI-backed assessment for Writing and Speaking — the two sections
 * with no answer key to grade mechanically against. Everything here is a
 * plain `fetch` against OpenAI's REST API rather than the `openai` SDK:
 * no extra dependency, and every call site already needs the same typed
 * try/catch-and-degrade shape regardless of how the HTTP call is made.
 *
 * Nothing here ever fabricates a band. If OPENAI_API_KEY isn't
 * configured, or a call fails, times out, or returns something that
 * doesn't parse as a valid assessment, the caller gets a typed failure
 * and the attempt is left honestly marked "pending review" (§42) — never
 * a made-up number.
 */

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const REQUEST_TIMEOUT_MS = 20_000;

export function isOpenAiConfigured(): boolean {
  return env.OPENAI_API_KEY.trim().length > 0;
}

export type AssessmentResult =
  | {
      success: true;
      criteria: Record<string, number>; // band x10 per criterion
      overallBandX10: number;
      feedback: string;
      raw: unknown;
    }
  | { success: false; error: string };

export type TranscriptionResult =
  | { success: true; transcript: string; raw: unknown }
  | { success: false; error: string };

const bandNumber = z
  .number()
  .min(0)
  .max(9)
  .refine((n) => Math.round(n * 2) === n * 2, "Band must be in 0.5 increments");

const writingAssessmentSchema = z.object({
  criteria: z.object({
    taskResponse: bandNumber,
    coherenceCohesion: bandNumber,
    lexicalResource: bandNumber,
    grammaticalRange: bandNumber,
  }),
  overallBand: bandNumber,
  feedback: z.string().min(1).max(4000),
});

const speakingAssessmentSchema = z.object({
  criteria: z.object({
    fluencyCoherence: bandNumber,
    lexicalResource: bandNumber,
    grammaticalRange: bandNumber,
    pronunciation: bandNumber,
  }),
  overallBand: bandNumber,
  feedback: z.string().min(1).max(4000),
});

function toCriteriaX10(criteria: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(criteria).map(([k, v]) => [k, Math.round(v * 10)]));
}

/**
 * Calls the Chat Completions API in JSON mode, with a hard timeout so a
 * slow or hanging call never blocks the attempt submission it's part of.
 */
async function callChatJson(params: {
  system: string;
  user: string;
}): Promise<{ success: true; content: string; raw: unknown } | { success: false; error: string }> {
  if (!isOpenAiConfigured()) {
    return { success: false, error: "OpenAI isn't configured (OPENAI_API_KEY is empty)." };
  }

  try {
    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: params.system },
          { role: "user", content: params.user },
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { success: false, error: `OpenAI request failed (${res.status}): ${body.slice(0, 300)}` };
    }

    const json = (await res.json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return { success: false, error: "OpenAI response had no message content." };
    }
    return { success: true, content, raw: json };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Request to OpenAI failed: ${message}` };
  }
}

/**
 * Condensed, original paraphrase of what each Writing criterion rewards —
 * not a reproduction of IELTS's own band descriptor wording — given to
 * the model as grading guidance.
 */
const WRITING_RUBRIC = `You are an experienced IELTS Writing examiner. Score the response on four criteria, each as a band from 0 to 9 in 0.5 increments:
- taskResponse: for Task 1, how fully and accurately the response reports the given data/situation; for Task 2, how fully it addresses all parts of the essay question with a clear, well-supported position.
- coherenceCohesion: logical organisation, paragraphing, and clarity of how ideas connect.
- lexicalResource: range and accuracy of vocabulary.
- grammaticalRange: range and accuracy of sentence structures and grammar.

Also give an overallBand (0-9, 0.5 increments) summarising the response, and concise, specific, constructive feedback (2-4 sentences) a student can act on — mention at least one concrete strength and one concrete improvement, quoting or paraphrasing the student's own text where useful.

Respond with ONLY a JSON object of this exact shape, no other text:
{"criteria": {"taskResponse": number, "coherenceCohesion": number, "lexicalResource": number, "grammaticalRange": number}, "overallBand": number, "feedback": string}`;

const SPEAKING_RUBRIC = `You are an experienced IELTS Speaking examiner. You are given a transcript of a candidate's spoken responses (transcribed by speech-to-text, so minor transcription artefacts are expected and should not be penalised). Score it on four criteria, each as a band from 0 to 9 in 0.5 increments:
- fluencyCoherence: how smoothly and coherently the candidate speaks, without excessive hesitation, and how well ideas connect.
- lexicalResource: range and accuracy of vocabulary used.
- grammaticalRange: range and accuracy of grammatical structures.
- pronunciation: inferred only from word choice, phrasing and transcription artefacts in the text (true pronunciation can't be heard from a transcript) — be conservative and say so in the feedback if there isn't enough signal.

Also give an overallBand (0-9, 0.5 increments) summarising the response, and concise, specific, constructive feedback (2-4 sentences) a student can act on.

Respond with ONLY a JSON object of this exact shape, no other text:
{"criteria": {"fluencyCoherence": number, "lexicalResource": number, "grammaticalRange": number, "pronunciation": number}, "overallBand": number, "feedback": string}`;

export async function assessWritingTask(params: {
  prompt: string;
  response: string;
  taskNumber: 1 | 2;
  testType: "ACADEMIC" | "GENERAL_TRAINING";
}): Promise<AssessmentResult> {
  if (!params.response.trim()) {
    return { success: false, error: "No response was submitted for this task." };
  }

  const taskKind =
    params.taskNumber === 1
      ? params.testType === "ACADEMIC"
        ? "Task 1 (Academic: describing visual data)"
        : "Task 1 (General Training: a letter)"
      : "Task 2 (an essay)";

  const result = await callChatJson({
    system: WRITING_RUBRIC,
    user: `This is IELTS Writing ${taskKind}.\n\nPrompt:\n${params.prompt}\n\nCandidate's response:\n${params.response}`,
  });
  if (!result.success) return result;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch {
    return { success: false, error: "OpenAI's response wasn't valid JSON." };
  }

  const validated = writingAssessmentSchema.safeParse(parsed);
  if (!validated.success) {
    return { success: false, error: `OpenAI's response didn't match the expected shape: ${validated.error.issues[0]?.message}` };
  }

  return {
    success: true,
    criteria: toCriteriaX10(validated.data.criteria),
    overallBandX10: Math.round(validated.data.overallBand * 10),
    feedback: validated.data.feedback,
    raw: result.raw,
  };
}

export async function assessSpeakingTranscript(params: {
  transcript: string;
  cueCardContext: string;
}): Promise<AssessmentResult> {
  if (!params.transcript.trim()) {
    return { success: false, error: "The transcript was empty." };
  }

  const result = await callChatJson({
    system: SPEAKING_RUBRIC,
    user: `Cue cards / topics covered in this Speaking test:\n${params.cueCardContext}\n\nTranscript of the candidate's spoken responses:\n${params.transcript}`,
  });
  if (!result.success) return result;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch {
    return { success: false, error: "OpenAI's response wasn't valid JSON." };
  }

  const validated = speakingAssessmentSchema.safeParse(parsed);
  if (!validated.success) {
    return { success: false, error: `OpenAI's response didn't match the expected shape: ${validated.error.issues[0]?.message}` };
  }

  return {
    success: true,
    criteria: toCriteriaX10(validated.data.criteria),
    overallBandX10: Math.round(validated.data.overallBand * 10),
    feedback: validated.data.feedback,
    raw: result.raw,
  };
}

/** Transcribes one Speaking recording via Whisper. */
export async function transcribeSpeakingAudio(params: {
  buffer: Buffer;
  filename: string;
}): Promise<TranscriptionResult> {
  if (!isOpenAiConfigured()) {
    return { success: false, error: "OpenAI isn't configured (OPENAI_API_KEY is empty)." };
  }

  try {
    const form = new FormData();
    // Buffer satisfies BlobPart at runtime; Node's Buffer isn't in the DOM
    // BlobPart type, hence the cast.
    form.append("file", new Blob([params.buffer as never]), params.filename);
    form.append("model", "whisper-1");
    form.append("response_format", "json");

    const res = await fetch(`${OPENAI_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { success: false, error: `Whisper request failed (${res.status}): ${body.slice(0, 300)}` };
    }

    const json = (await res.json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (typeof json?.text !== "string") {
      return { success: false, error: "Whisper response had no transcript text." };
    }
    return { success: true, transcript: json.text, raw: json };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Request to Whisper failed: ${message}` };
  }
}
