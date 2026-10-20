import { describe, expect, it } from "vitest";
import { installPack, orderVariables, Kind, WorkspaceApi } from "../src/install.js";

/** An in-memory workspace that behaves like Tag Manager's: it hands out ids and remembers what it was given. */
function fakeApi(existing: Partial<Record<Kind, [string, string][]>> = {}) {
  const store: Record<Kind, { id: string; body: any }[]> = { templates: [], variables: [], triggers: [], clients: [], tags: [], transformations: [] };
  const builtIns: string[][] = [];
  let n = 100;
  const api: WorkspaceApi = {
    async existing(kind) {
      return new Map(existing[kind] ?? []);
    },
    async create(kind, body) {
      if (body.name === "BOOM") throw new Error("quota");
      const id = String(++n);
      store[kind].push({ id, body });
      return id;
    },
    async enableBuiltIns(types) {
      builtIns.push(types);
    },
  };
  return { api, store, builtIns };
}

const pack = {
  containerVersion: {
    containerId: "100000002",
    builtInVariable: [{ type: "EVENT", name: "Event" }],
    customTemplate: [{ templateId: "90", name: "Meta Pixel", templateData: "___INFO___", accountId: "1", containerId: "100000002" }],
    variable: [
      { variableId: "12", name: "- Email - Open Tracked", type: "jsm", parameter: [{ key: "javascript", value: "return {{- DLV a - Open Tracked}};" }], fingerprint: "1" },
      { variableId: "11", name: "- DLV a - Open Tracked", type: "v", parameter: [], fingerprint: "1" },
      { variableId: "13", name: "- Event ID - Open Tracked", type: "cvt_100000002_90", parameter: [] },
    ],
    trigger: [{ triggerId: "30", name: "- View Item - Open Tracked", type: "CUSTOM_EVENT" }],
    client: [],
    tag: [
      { tagId: "60", name: "- Meta - ViewContent - Open Tracked", type: "cvt_100000002_90", firingTriggerId: ["30", "2147479553"], parameter: [{ key: "x", value: "{{- Email - Open Tracked}}" }] },
    ],
    transformation: [
      { transformationId: "5", name: "- Enrich - Open Tracked", type: "tf_augment_event", parameter: [{ key: "affectedTagTypes", list: [{ map: [{ key: "tagType", value: "cvt_100000002_90" }] }] }] },
    ],
  },
};

describe("installPack", () => {
  it("creates everything and rewrites template types and trigger ids to the real ones", async () => {
    const { api, store, builtIns } = fakeApi();
    const report = await installPack(api, pack, { containerId: "555" });

    expect(report.failed).toEqual([]);
    expect(report.created).toEqual({ templates: 1, variables: 3, triggers: 1, clients: 0, tags: 1, transformations: 1 });
    expect(builtIns).toEqual([["EVENT"]]);

    const templateId = store.templates[0].id;
    expect(store.variables.find((v) => v.body.name === "- Event ID - Open Tracked")!.body.type).toBe(`cvt_555_${templateId}`);
    const tag = store.tags[0].body;
    expect(tag.type).toBe(`cvt_555_${templateId}`);
    expect(tag.firingTriggerId).toEqual([store.triggers[0].id, "2147479553"]);        // new trigger id, the built-in one untouched
    expect(JSON.stringify(store.transformations[0].body)).toContain(`cvt_555_${templateId}`);
  });

  it("strips what the server assigns, so Tag Manager is not handed ids of another container", async () => {
    const { api, store } = fakeApi();
    await installPack(api, pack, { containerId: "555" });
    for (const kind of ["variables", "triggers", "tags", "templates"] as Kind[]) {
      for (const { body } of store[kind]) {
        for (const k of ["accountId", "containerId", "fingerprint", "tagId", "triggerId", "variableId", "templateId"]) expect(body).not.toHaveProperty(k);
      }
    }
  });

  it("creates a variable after the variable it points at", async () => {
    const { api, store } = fakeApi();
    await installPack(api, pack, { containerId: "555" });
    const names = store.variables.map((v) => v.body.name);
    expect(names.indexOf("- DLV a - Open Tracked")).toBeLessThan(names.indexOf("- Email - Open Tracked"));
  });

  it("skips what the workspace already has, so running it twice is safe, and still maps to the existing ids", async () => {
    const { api, store } = fakeApi({ templates: [["Meta Pixel", "77"]], triggers: [["- View Item - Open Tracked", "88"]] });
    const report = await installPack(api, pack, { containerId: "555" });

    expect(report.skipped.map((s) => s.name)).toEqual(["Meta Pixel", "- View Item - Open Tracked"]);
    expect(store.tags[0].body.type).toBe("cvt_555_77");
    expect(store.tags[0].body.firingTriggerId[0]).toBe("88");
  });

  it("keeps going when one object fails and says which", async () => {
    const { api } = fakeApi();
    const bad = JSON.parse(JSON.stringify(pack));
    bad.containerVersion.tag.push({ tagId: "61", name: "BOOM", type: "html", firingTriggerId: ["30"], parameter: [] });
    const report = await installPack(api, bad, { containerId: "555" });

    expect(report.failed).toEqual([{ kind: "tags", name: "BOOM", error: "quota" }]);
    expect(report.created.tags).toBe(1);
  });
});

describe("orderVariables", () => {
  it("survives a cycle by taking the rest as they are", () => {
    const out = orderVariables([
      { name: "a", parameter: [{ value: "{{b}}" }] },
      { name: "b", parameter: [{ value: "{{a}}" }] },
    ]);
    expect(out.map((v) => v.name).sort()).toEqual(["a", "b"]);
  });
});
