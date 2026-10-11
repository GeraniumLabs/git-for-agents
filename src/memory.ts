// Project memory: what the humans decided, and what earlier agents tried.
// Pure helpers; the coordinator owns the tables.

export interface Decision {
  id: number;
  kind: "answer" | "directive" | "review" | "ruling" | "note" | "contest";
  question: string;
  decision: string;
  by: string;
  byName: string | null;
  paths: string[];
  task_id: number | null;
  change_id: number | null;
  thread_id: number | null;
  created_at: number;
}

const STOP = new Set("a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or our should so that the their them then there these this to us we what when where which who why will with would you your".split(" "));

export function words(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9_./-]+/g, " ").split(" ")
      .map((w) => w.replace(/^[./-]+|[./-]+$/g, ""))
      .filter((w) => w.length > 1 && !STOP.has(w))
      .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w)),
  );
}

/** Word overlap between two texts, 0..1 (Jaccard over content words). */
export function similarity(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** The same question asked again, give or take punctuation and case. */
export function sameQuestion(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(a) === norm(b);
}

/** An agent is "present" if it has been active recently and isn't paused. */
export const PRESENT_MS = 10 * 60_000;
