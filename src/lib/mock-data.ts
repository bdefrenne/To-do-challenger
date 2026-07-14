/*
  ====================================================================
  MOCK DATA — the single file to edit to change the sample content.
  No backend; everything here is hand-authored sample data shaped to
  the types in ./types.ts. Swap this module for a real API later and
  the screens keep working.
  ====================================================================
*/

import type { Tag, Task } from "./types";

export const DEFAULT_ASSIGNEE = "You";

/** People who can be assigned (avatars derive their initials from the name). */
export const PEOPLE: string[] = ["You", "Alex", "Sam", "Priya"];

/** Tag catalog — referenced by id from a task's `tags`. */
export const TAGS: Tag[] = [
  { id: "work", label: "Work", tone: "purple" },
  { id: "personal", label: "Personal", tone: "blue" },
  { id: "home", label: "Home", tone: "green" },
  { id: "errand", label: "Errand", tone: "amber" },
  { id: "health", label: "Health", tone: "pink" },
  { id: "finance", label: "Finance", tone: "gray" },
];

export function tagById(id: string): Tag | undefined {
  return TAGS.find((t) => t.id === id);
}

/* ---- Tasks (List view, ClickUp-style grouped table). ----
   Statuses: backlog (To Do) → planned → in-progress → done. */
export const TASKS: Task[] = [
  /* ----- IN PROGRESS ----- */
  {
    id: "t-1",
    title: "Write the Q3 planning doc",
    status: "in-progress",
    priority: "high",
    assignee: "You",
    dueDate: "2026-07-15",
    tags: ["work"],
    commentCount: 3,
    updatedAt: "2026-07-14T09:20:00+02:00",
    description:
      "Draft the goals, key results and headcount asks for Q3. Circulate for feedback before the Thursday sync.",
    subtasks: [
      {
        id: "t-1a",
        title: "Outline the three top-level goals",
        status: "done",
        priority: "normal",
        assignee: "You",
        updatedAt: "2026-07-13T16:00:00+02:00",
      },
      {
        id: "t-1b",
        title: "Pull last quarter's metrics",
        status: "in-progress",
        priority: "normal",
        assignee: "You",
        dueDate: "2026-07-15",
      },
      {
        id: "t-1c",
        title: "Draft the headcount ask",
        status: "backlog",
        priority: "low",
        assignee: "You",
      },
    ],
  },

  /* ----- PLANNED (today's shortlist) ----- */
  {
    id: "t-2",
    title: "Review Alex's pull request",
    status: "planned",
    priority: "urgent",
    assignee: "You",
    dueDate: "2026-07-14",
    tags: ["work"],
    commentCount: 1,
    updatedAt: "2026-07-14T08:05:00+02:00",
  },
  {
    id: "t-3",
    title: "Book the dentist appointment",
    status: "planned",
    priority: "high",
    assignee: "You",
    dueDate: "2026-07-14",
    tags: ["health", "personal"],
    updatedAt: "2026-07-13T18:30:00+02:00",
  },
  {
    id: "t-4",
    title: "Grocery run for the week",
    status: "planned",
    priority: "normal",
    assignee: "You",
    dueDate: "2026-07-15",
    tags: ["errand", "home"],
    updatedAt: "2026-07-13T19:00:00+02:00",
    subtasks: [
      {
        id: "t-4a",
        title: "Make a list from the meal plan",
        status: "planned",
        priority: "low",
        assignee: "You",
      },
    ],
  },
  {
    id: "t-5",
    title: "Prep slides for the team demo",
    status: "planned",
    priority: "high",
    assignee: "Sam",
    dueDate: "2026-07-16",
    tags: ["work"],
    commentCount: 5,
    updatedAt: "2026-07-13T11:00:00+02:00",
  },

  /* ----- BACKLOG (To Do) ----- */
  {
    id: "t-6",
    title: "Renew the car insurance",
    status: "backlog",
    priority: "high",
    assignee: "You",
    dueDate: "2026-07-20",
    tags: ["finance", "errand"],
    updatedAt: "2026-07-10T10:00:00+02:00",
  },
  {
    id: "t-7",
    title: "Fix the leaking kitchen tap",
    status: "backlog",
    priority: "normal",
    assignee: "You",
    tags: ["home"],
    updatedAt: "2026-07-09T14:00:00+02:00",
  },
  {
    id: "t-8",
    title: "Plan the September team offsite",
    status: "backlog",
    priority: "normal",
    assignee: "Priya",
    dueDate: "2026-08-01",
    tags: ["work"],
    commentCount: 2,
    updatedAt: "2026-07-08T13:00:00+02:00",
    subtasks: [
      {
        id: "t-8a",
        title: "Shortlist three venues",
        status: "backlog",
        priority: "low",
        assignee: "Priya",
      },
      {
        id: "t-8b",
        title: "Send a date poll",
        status: "backlog",
        priority: "low",
        assignee: "Priya",
      },
    ],
  },
  {
    id: "t-9",
    title: "Read 'Shape Up' chapters 3–5",
    status: "backlog",
    priority: "low",
    assignee: "You",
    tags: ["personal"],
    updatedAt: "2026-07-06T21:00:00+02:00",
  },
  {
    id: "t-10",
    title: "Set up automatic savings transfer",
    status: "backlog",
    priority: "normal",
    assignee: "You",
    tags: ["finance"],
    updatedAt: "2026-07-05T10:00:00+02:00",
  },
  {
    id: "t-11",
    title: "Water the plants",
    status: "backlog",
    priority: "low",
    assignee: "You",
    tags: ["home"],
    updatedAt: "2026-07-11T08:00:00+02:00",
  },
  {
    id: "t-12",
    title: "Draft blog post on the new release",
    status: "backlog",
    priority: "normal",
    assignee: "Alex",
    dueDate: "2026-07-22",
    tags: ["work"],
    updatedAt: "2026-07-07T15:30:00+02:00",
  },

  /* ----- DONE (Complete) ----- */
  {
    id: "t-13",
    title: "Send the invoice to the client",
    status: "done",
    priority: "high",
    assignee: "You",
    tags: ["finance", "work"],
    updatedAt: "2026-07-13T17:00:00+02:00",
  },
  {
    id: "t-14",
    title: "Reply to the landlord about the lease",
    status: "done",
    priority: "normal",
    assignee: "You",
    tags: ["home"],
    updatedAt: "2026-07-12T12:00:00+02:00",
  },
  {
    id: "t-15",
    title: "Cancel the unused streaming subscription",
    status: "done",
    priority: "low",
    assignee: "You",
    tags: ["finance"],
    updatedAt: "2026-07-11T20:00:00+02:00",
  },
];
