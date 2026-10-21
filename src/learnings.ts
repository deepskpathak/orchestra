// Compound memory: lessons the librarian distills after each run, fed to future planners/workers/judges.

import type { Store } from './store.ts';

export interface Lesson {
  role: 'planner' | 'worker' | 'judge';
  lesson: string;
}

export function readLearnings(store: Store): Lesson[] {
  return store.readJson<{ lessons: Lesson[] }>('learnings.json', { lessons: [] }).lessons;
}

export function writeLearnings(store: Store, lessons: Lesson[], runId: string): void {
  const clean = lessons
    .filter((l) => l && typeof l.lesson === 'string' && l.lesson.trim())
    .slice(0, 25)
    .map((l) => ({ role: (['planner', 'worker', 'judge'].includes(l.role) ? l.role : 'worker') as Lesson['role'], lesson: l.lesson.trim() }));
  store.writeJson('learnings.json', { updatedAt: Date.now(), run: runId, lessons: clean });
  // Human-readable mirror, so you can read and edit what the factory has learned.
  const md = ['# Orchestra learnings', '', `Updated after run ${runId}.`, ''];
  for (const role of ['planner', 'worker', 'judge'] as const) {
    const ls = clean.filter((l) => l.role === role);
    if (!ls.length) continue;
    md.push(`## ${role}`, '', ...ls.map((l) => `- ${l.lesson}`), '');
  }
  store.writeText('learnings.md', md.join('\n'));
}

export function formatLearnings(lessons: Lesson[], role: Lesson['role']): string {
  const mine = lessons.filter((l) => l.role === role);
  const rest = lessons.filter((l) => l.role !== role);
  const lines = [...mine, ...rest].map((l) => `- [${l.role}] ${l.lesson}`);
  return lines.length ? lines.join('\n') : '(none yet)';
}
