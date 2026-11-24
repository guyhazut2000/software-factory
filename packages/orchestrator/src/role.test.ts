import { describe, it, expect } from "vitest";
import { Db } from "./db.js";
import { Hub } from "./hub.js";
import { Engine } from "./engine.js";
import { buildInstructions } from "./instructions.js";
import { sbxCreateArgs, sandboxNameFor } from "./workspace.js";

describe("per-agent role instructions + sandbox recreate (M4.4)", () => {
  const db = new Db(":memory:");
  const engine = new Engine(db, new Hub());
  it("stores role instructions and appends them to the system prompt", () => {
    const a = engine.createAgent({ name: "Dev", role: "developer", description: "Builds things", instructions: "Always add a test." });
    expect(db.get("SELECT instructions FROM agents WHERE id=?", a.id)?.instructions).toBe("Always add a test.");
    engine.updateAgent(a.id, { instructions: "Prefer small PRs." });
    const row = db.get("SELECT * FROM agents WHERE id=?", a.id)!;
    const sys = buildInstructions(undefined, row, []);
    expect(sys).toContain("# Role instructions\nPrefer small PRs.");
    expect(sys.indexOf("Prefer small PRs.")).toBeLessThan(sys.indexOf("# Operating rules"));
    expect(buildInstructions(undefined, { ...row, instructions: "" }, [])).not.toContain("# Role instructions");
  });
  it("passes CPU/RAM to sbx create only when set", () => {
    expect(sbxCreateArgs({ name: "sf-1", sbxAgent: "claude", dir: "/r", cpu: 4, ramMb: 8192 })).toEqual(["create", "--clone", "--name", "sf-1", "--cpus", "4", "--memory", "8192m", "claude", "/r"]);
    expect(sbxCreateArgs({ name: "sf-1", sbxAgent: "claude", dir: "/r", cpu: 0, ramMb: 100 })).toEqual(["create", "--clone", "--name", "sf-1", "claude", "/r"]);
    expect(sandboxNameFor("abcdef123456")).toBe("sf-abcdef12");
  });
  it("refuses to recreate when the agent has no task", async () => {
    const a = engine.createAgent({ name: "Idle" });
    await expect(engine.recreateSandbox(a.id)).rejects.toThrow(/no task/);
    await expect(engine.recreateSandbox("nope")).rejects.toThrow(/not found/);
  });
});
