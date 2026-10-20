/**
 * Puts an Open Tracked GTM pack (the JSON the app builds) into a Tag Manager workspace, object by object.
 * GTM has no "import container" call in its API, so this recreates what Admin > Import Container does: templates first,
 * then variables (in dependency order), triggers, clients, tags and transformations, rewriting the ids that change on the way.
 */

export type Kind = "templates" | "variables" | "triggers" | "clients" | "tags" | "transformations";

export interface WorkspaceApi {
  /** name -> id of what the workspace already holds */
  existing(kind: Kind): Promise<Map<string, string>>;
  create(kind: Kind, body: Record<string, any>): Promise<string>;
  enableBuiltIns(types: string[]): Promise<void>;
}

export interface InstallReport {
  created: Record<Kind, number>;
  skipped: { kind: Kind; name: string }[];
  failed: { kind: Kind; name: string; error: string }[];
}

const SERVER_ASSIGNED = [
  "accountId", "containerId", "workspaceId", "fingerprint", "path", "tagManagerUrl", "parentFolderId",
  "tagId", "triggerId", "variableId", "clientId", "transformationId", "templateId", "galleryReference",
];

const clean = (o: Record<string, any>) => {
  const copy: Record<string, any> = JSON.parse(JSON.stringify(o));
  for (const k of SERVER_ASSIGNED) delete copy[k];
  return copy;
};

/** Variables that point at other variables must come after them. */
export function orderVariables(vars: Record<string, any>[]): Record<string, any>[] {
  const names = new Set(vars.map((v) => v.name));
  const deps = new Map<string, Set<string>>();
  for (const v of vars) {
    const refs = new Set<string>();
    for (const m of JSON.stringify(v.parameter ?? []).matchAll(/\{\{([^{}]+?)\}\}/g)) {
      if (names.has(m[1]) && m[1] !== v.name) refs.add(m[1]);
    }
    deps.set(v.name, refs);
  }
  const out: Record<string, any>[] = [];
  const done = new Set<string>();
  let left = [...vars];
  while (left.length) {
    const ready = left.filter((v) => [...deps.get(v.name)!].every((d) => done.has(d)));
    const batch = ready.length ? ready : left;              // a cycle: take the rest as they are
    for (const v of batch) {
      out.push(v);
      done.add(v.name);
    }
    left = left.filter((v) => !batch.includes(v));
  }
  return out;
}

export interface InstallOptions {
  /** the numeric id of the real GTM container: custom template types are cvt_<containerId>_<templateId> */
  containerId: string;
  onProgress?: (message: string) => void;
}

export async function installPack(api: WorkspaceApi, pack: { containerVersion: Record<string, any> }, opts: InstallOptions): Promise<InstallReport> {
  const cv = pack.containerVersion;
  const packContainerId: string = cv.containerId;
  const report: InstallReport = {
    created: { templates: 0, variables: 0, triggers: 0, clients: 0, tags: 0, transformations: 0 },
    skipped: [],
    failed: [],
  };
  const say = opts.onProgress ?? (() => undefined);
  const typeMap = new Map<string, string>();
  const triggerMap = new Map<string, string>();

  const retype = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(retype);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, retype(x)]));
    return typeof v === "string" && typeMap.has(v) ? typeMap.get(v) : v;
  };
  const make = async (kind: Kind, name: string, body: Record<string, any>, existing: Map<string, string>) => {
    if (existing.has(name)) {
      report.skipped.push({ kind, name });
      return existing.get(name)!;
    }
    try {
      const id = await api.create(kind, body);
      report.created[kind]++;
      return id;
    } catch (e: any) {
      report.failed.push({ kind, name, error: String(e?.message ?? e) });
      return undefined;
    }
  };

  const builtIns = (cv.builtInVariable ?? []).map((b: any) => b.type);
  if (builtIns.length) {
    say("Turning on built-in variables");
    await api.enableBuiltIns(builtIns);
  }

  say(`Templates (${(cv.customTemplate ?? []).length})`);
  const haveTemplates = await api.existing("templates");
  for (const t of cv.customTemplate ?? []) {
    const id = await make("templates", t.name, { name: t.name, templateData: t.templateData }, haveTemplates);
    if (id) typeMap.set(`cvt_${packContainerId}_${t.templateId}`, `cvt_${opts.containerId}_${id}`);
  }

  say(`Variables (${(cv.variable ?? []).length})`);
  const haveVars = await api.existing("variables");
  for (const v of orderVariables(cv.variable ?? [])) {
    await make("variables", v.name, retype(clean(v)) as Record<string, any>, haveVars);
  }

  say(`Triggers (${(cv.trigger ?? []).length})`);
  const haveTriggers = await api.existing("triggers");
  for (const t of cv.trigger ?? []) {
    const id = await make("triggers", t.name, clean(t), haveTriggers);
    if (id) triggerMap.set(t.triggerId, id);
  }

  if ((cv.client ?? []).length) {
    say(`Clients (${cv.client.length})`);
    const haveClients = await api.existing("clients");
    for (const c of cv.client) await make("clients", c.name, retype(clean(c)) as Record<string, any>, haveClients);
  }

  say(`Tags (${(cv.tag ?? []).length})`);
  const haveTags = await api.existing("tags");
  for (const t of cv.tag ?? []) {
    const body = retype(clean(t)) as Record<string, any>;
    for (const key of ["firingTriggerId", "blockingTriggerId"]) {
      if (Array.isArray(body[key])) body[key] = body[key].map((id: string) => triggerMap.get(id) ?? id);
    }
    await make("tags", t.name, body, haveTags);
  }

  if ((cv.transformation ?? []).length) {
    say(`Transformations (${cv.transformation.length})`);
    const haveTf = await api.existing("transformations");
    for (const t of cv.transformation) await make("transformations", t.name, retype(clean(t)) as Record<string, any>, haveTf);
  }

  return report;
}

// ------------------------------------------------------------------ the real thing, over the Tag Manager API

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tag Manager's quota is small: slow down and try again when it says so. */
export async function withRetry<T>(fn: () => Promise<T>, pauseMs = 400, tries = 6): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await fn();
      if (pauseMs) await sleep(pauseMs);
      return out;
    } catch (e: any) {
      const code = Number(e?.code ?? e?.status);
      const reason = JSON.stringify(e?.errors ?? e?.message ?? "");
      const transient = code === 429 || code >= 500 || (code === 403 && /rate|quota/i.test(reason));
      if (!transient || attempt >= tries) throw e;
      await sleep(Math.min(60_000, 2000 * 2 ** attempt));
    }
  }
}

const LIST_KEY: Record<Kind, string> = { templates: "template", variables: "variable", triggers: "trigger", clients: "client", tags: "tag", transformations: "transformation" };
const ID_KEY: Record<Kind, string> = { templates: "templateId", variables: "variableId", triggers: "triggerId", clients: "clientId", tags: "tagId", transformations: "transformationId" };

export function workspaceApi(tagmanager: any, workspacePath: string, pauseMs = 400): WorkspaceApi {
  const ws = tagmanager.accounts.containers.workspaces;
  const resource = (kind: Kind) => ws[kind];

  return {
    async existing(kind) {
      const out = new Map<string, string>();
      let pageToken: string | undefined;
      do {
        const res = await withRetry<any>(() => resource(kind).list({ parent: workspacePath, pageToken }), pauseMs);
        for (const item of res.data[LIST_KEY[kind]] ?? []) out.set(item.name, item[ID_KEY[kind]]);
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      return out;
    },
    async create(kind, body) {
      const res = await withRetry<any>(() => resource(kind).create({ parent: workspacePath, requestBody: body }), pauseMs);
      return String(res.data[ID_KEY[kind]]);
    },
    async enableBuiltIns(types) {
      await withRetry(() => ws.built_in_variables.create({ parent: workspacePath, type: types }), pauseMs);
    },
  };
}
