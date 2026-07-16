/*
  ====================================================================
  MOCK DATA — the single file to edit to change the sample content.
  No backend; everything here is hand-authored sample data shaped to
  the types in ./types.ts. Swap this module for a real API later and
  the screens keep working.
  ====================================================================
*/

import type { Task } from "./types";

/* ---- Tasks (List view, ClickUp-style grouped table). ----
   Statuses: backlog (To Do) → planned → in-progress → done. */
export const TASKS: Task[] = [
  /* ----- IN PROGRESS ----- */
  {
    id: "t-1",
    title: "Write the Q3 planning doc",
    status: "in-progress",
    startDate: "2026-07-12",
    dueDate: "2026-07-15",
    value: 8,
    difficulty: 5,
    recurrence: "none",
    commentCount: 3,
    updatedAt: "2026-07-14T09:20:00+02:00",
    description:
      "Draft the goals, key results and headcount asks for Q3. Circulate for feedback before the Thursday sync.",
    subtasks: [
      {
        id: "t-1a",
        title: "Outline the three top-level goals",
        status: "done",
        updatedAt: "2026-07-13T16:00:00+02:00",
      },
      {
        id: "t-1b",
        title: "Pull last quarter's metrics",
        status: "in-progress",
        dueDate: "2026-07-15",
      },
      {
        id: "t-1c",
        title: "Draft the headcount ask",
        status: "backlog",
      },
    ],
  },

  /* ----- PLANNED (today's shortlist) ----- */
  {
    id: "t-2",
    title: "Review Alex's pull request",
    status: "planned",
    dueDate: "2026-07-14",
    value: 3,
    difficulty: 2,
    dependsOn: ["t-1"],
    commentCount: 1,
    updatedAt: "2026-07-14T08:05:00+02:00",
  },
  {
    id: "t-3",
    title: "Book the dentist appointment",
    status: "planned",
    dueDate: "2026-07-14",
    updatedAt: "2026-07-13T18:30:00+02:00",
  },
  {
    id: "t-4",
    title: "Grocery run for the week",
    status: "planned",
    dueDate: "2026-07-15",
    recurrence: "weekly",
    customFields: { Store: "Whole Foods", Budget: 120 },
    updatedAt: "2026-07-13T19:00:00+02:00",
    subtasks: [
      {
        id: "t-4a",
        title: "Make a list from the meal plan",
        status: "planned",
      },
    ],
  },
  {
    id: "t-5",
    title: "Prep slides for the team demo",
    status: "planned",
    dueDate: "2026-07-16",
    commentCount: 5,
    updatedAt: "2026-07-13T11:00:00+02:00",
  },

  /* ----- BACKLOG (To Do) ----- */
  {
    id: "t-6",
    title: "Renew the car insurance",
    status: "backlog",
    dueDate: "2026-07-20",
    updatedAt: "2026-07-10T10:00:00+02:00",
  },
  {
    id: "t-7",
    title: "Fix the leaking kitchen tap",
    status: "backlog",
    updatedAt: "2026-07-09T14:00:00+02:00",
  },
  {
    id: "t-8",
    title: "Plan the September team offsite",
    status: "backlog",
    dueDate: "2026-08-01",
    commentCount: 2,
    updatedAt: "2026-07-08T13:00:00+02:00",
    subtasks: [
      {
        id: "t-8a",
        title: "Shortlist three venues",
        status: "backlog",
      },
      {
        id: "t-8b",
        title: "Send a date poll",
        status: "backlog",
      },
    ],
  },
  {
    id: "t-9",
    title: "Read 'Shape Up' chapters 3–5",
    status: "backlog",
    updatedAt: "2026-07-06T21:00:00+02:00",
  },
  {
    id: "t-10",
    title: "Set up automatic savings transfer",
    status: "backlog",
    updatedAt: "2026-07-05T10:00:00+02:00",
  },
  {
    id: "t-11",
    title: "Water the plants",
    status: "backlog",
    updatedAt: "2026-07-11T08:00:00+02:00",
  },
  {
    id: "t-12",
    title: "Draft blog post on the new release",
    status: "backlog",
    dueDate: "2026-07-22",
    updatedAt: "2026-07-07T15:30:00+02:00",
  },

  /* ----- DONE (Complete) ----- */
  {
    id: "t-13",
    title: "Send the invoice to the client",
    status: "done",
    updatedAt: "2026-07-13T17:00:00+02:00",
  },
  {
    id: "t-14",
    title: "Reply to the landlord about the lease",
    status: "done",
    updatedAt: "2026-07-12T12:00:00+02:00",
  },
  {
    id: "t-15",
    title: "Cancel the unused streaming subscription",
    status: "done",
    updatedAt: "2026-07-11T20:00:00+02:00",
  },
];
