import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import * as s from "./schema.js";

describe("schema", () => {
  it("exposes all tables", () => {
    const names = [s.projects, s.agents, s.tasks, s.runs, s.messages, s.questions, s.costs].map(getTableName);
    expect(names).toEqual(["projects", "agents", "tasks", "runs", "messages", "questions", "costs"]);
  });
});
