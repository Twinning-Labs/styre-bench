import { describe, expect, test } from "bun:test";
import {
  CONTAINER_NAME_PREFIX,
  benchContainerNames,
  containerNameFor,
  reapBenchContainers,
} from "../orchestrator/container-reaper";

describe("containerNameFor", () => {
  test("prefixes so a bench container is greppable and never confused with an operator's own", () => {
    const name = containerNameFor("darkreader__darkreader-7241-20260910-182531-44709ece");
    expect(name.startsWith(CONTAINER_NAME_PREFIX)).toBe(true);
    expect(name).toContain("7241");
  });

  test("sanitises to what docker --name actually accepts", () => {
    // Docker allows [a-zA-Z0-9][a-zA-Z0-9_.-]*; an evidence dir basename can carry anything.
    const name = containerNameFor("weird name/with:chars");
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  });

  test("never produces a bare prefix ending in a separator", () => {
    expect(containerNameFor("///")).toBe(`${CONTAINER_NAME_PREFIX}run`);
  });
});

describe("benchContainerNames", () => {
  test("selects only bench containers, by name prefix not by image", () => {
    // Identifying by image would sweep up an operator's own container built from the same
    // corpus image — the bench must only ever kill what it started.
    const ps = [
      "styre-bench-darkreader-1",
      "my-own-darkreader-container",
      "styre-bench-astropy-2",
      "postgres",
      "",
    ].join("\n");
    expect(benchContainerNames(ps)).toEqual(["styre-bench-darkreader-1", "styre-bench-astropy-2"]);
  });

  test("empty docker ps output yields nothing", () => {
    expect(benchContainerNames("")).toEqual([]);
    expect(benchContainerNames("\n\n")).toEqual([]);
  });
});

describe("reapBenchContainers", () => {
  test("kills every leftover bench container and reports them", async () => {
    const killed: string[] = [];
    const out = await reapBenchContainers({
      listRunning: async () => "styre-bench-a\nother\nstyre-bench-b\n",
      kill: async (n) => {
        killed.push(n);
      },
    });
    expect(killed).toEqual(["styre-bench-a", "styre-bench-b"]);
    expect(out).toEqual(["styre-bench-a", "styre-bench-b"]);
  });

  test("a docker daemon that is down does not fail the pilot", async () => {
    // Reaping is hygiene, not a precondition — it must never block a run from starting.
    const out = await reapBenchContainers({
      listRunning: async () => {
        throw new Error("Cannot connect to the Docker daemon");
      },
      kill: async () => {},
    });
    expect(out).toEqual([]);
  });

  test("a container that vanishes between list and kill is skipped, not fatal", async () => {
    const out = await reapBenchContainers({
      listRunning: async () => "styre-bench-gone\nstyre-bench-live\n",
      kill: async (n) => {
        if (n === "styre-bench-gone") throw new Error("No such container");
      },
    });
    expect(out).toEqual(["styre-bench-live"]);
  });
});
