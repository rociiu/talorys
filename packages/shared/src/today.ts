import type { Automation, Project, Task } from "./schemas";

export interface TodayTaskGroups {
  today: Task[];
  overdue: Task[];
  upcoming: Task[];
}

export interface TodayCounts {
  open: number;
  today: number;
  overdue: number;
  upcoming: number;
}

export interface TodayProject extends Project {
  open_tasks: number;
  overdue_tasks: number;
  due_soon_tasks: number;
  next_due_at: string | null;
  last_activity_at: string;
}

export type TodaySuggestion =
  | { kind: "review_overdue"; count: number }
  | { kind: "plan_project" | "review_project"; project_id: string; project_name: string; count: number }
  | { kind: "create_first_task" };

export interface TodayOverview {
  generated_at: string;
  timezone: string;
  local_date: string;
  counts: TodayCounts;
  focus: Task[];
  tasks: TodayTaskGroups;
  projects: TodayProject[];
  automations: Automation[];
  suggestion: TodaySuggestion | null;
}
