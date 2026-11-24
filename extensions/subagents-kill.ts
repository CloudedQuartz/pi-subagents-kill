/*
 * subagents-kill.ts — /subagents-kill: deliberately abort running or queued subagents through the
 * pi-subagents service API. ESC is not an on-demand abort (abortAllOnInterrupt either kills every
 * subagent with the parent interrupt or none), and pi-subagents ships no abort tool or command, so
 * this is the "now kill them" half of the workflow: abortAllOnInterrupt off + ESC to release a
 * waiting get_subagent_result, then /subagents-kill when you mean it.
 *
 *   /subagents-kill            pick from a selector (one agent or "All active"), then confirm
 *   /subagents-kill all        confirm once, abort every running/queued agent
 *   /subagents-kill <id|pref>  abort one; a unique id prefix works, an ambiguous one reopens the
 *                              selector scoped to the matches
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface KillRecord {
  id: string;
  type: string;
  description: string;
  status: string;
}
/** The slice of the pi-subagents service contract this command uses. */
interface KillService {
  listAgents(): KillRecord[];
  abort(id: string): boolean;
  /** Present on the real adapter; used in diagnostics only. */
  hasRunning?(): boolean;
  /** Present on the real adapter; used to recognize the parent's own records. */
  getRecord?(id: string): KillRecord | undefined;
}
interface KillDeps {
  /** Test seam; defaults to resolving the real published service. */
  getService?: () => KillService | undefined | Promise<KillService | undefined>;
  /** Test seam; defaults to appending a JSON line under the pi agent dir. */
  log?: (entry: Record<string, unknown>) => void;
}
type ServiceModule = { getSubagentsService?: () => KillService | undefined };

// ---- Diagnostics: one JSON line per invocation so behavior is inspectable from disk ----

/** Stable per-process identity for service objects, so logs can tell adapter instances apart. */
const serviceIds = new WeakMap<object, number>();
let nextServiceId = 1;
function serviceIdOf(service: KillService): number {
  if (!serviceIds.has(service)) serviceIds.set(service, nextServiceId++);
  return serviceIds.get(service)!;
}

function defaultLog(entry: Record<string, unknown>): void {
  try {
    const file = join(
      process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
      "subagents-kill.log",
    );
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
  } catch {
    // Logging is best-effort; never break the command over it.
  }
}

const ACTIVE = new Set(["running", "queued"]);
const shortId = (id: string): string => id.slice(0, 8);
const clip = (text: string, max = 60): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const labelOf = (r: KillRecord): string => `${shortId(r.id)}  ${r.type}  ${r.status}  —  ${clip(r.description)}`;
const plural = (n: number): string => (n === 1 ? "" : "s");

// ---- Parent-adapter selection ----
//
// Proven from logs (2026-10-09): a child session re-runs this package's factory
// in-process during bindExtensions and overwrites the process-global service key
// (Symbol.for) with an adapter over the CHILD's manager, so a live lookup while
// any child runs returns an adapter that cannot see the parent's records — the
// command reported recordCount 0 while the parent manager held a running agent.
// Fix: hold the adapter captured at load/session_start (before children exist),
// and disambiguate candidates with ids this parent runtime spawned (only the
// parent adapter knows them) or, failing that, hasRunning().

/** Ids of agents spawned through this runtime, tracked from the parent event bus. */
const knownParentIds = new Set<string>();

interface ServiceCandidate {
  service: KillService;
  source: string;
}
type SelectReason = "deps" | "known-id" | "hasRunning" | "held-first" | "live-only" | "none";

/**
 * Pick the adapter to trust. Candidates arrive best-first (held parent capture,
 * then live lookup); only the parent adapter can know a parent-spawned id, and
 * while agents run only the parent adapter reports hasRunning().
 */
function selectService(
  candidates: ServiceCandidate[],
  knownIds: ReadonlySet<string>,
): { candidate?: ServiceCandidate; reason: SelectReason } {
  if (candidates.length === 0) return { reason: "none" };
  const byKnown = candidates.find((c) => {
    if (!c.service.getRecord) return false;
    for (const id of knownIds) if (c.service.getRecord(id)) return true;
    return false;
  });
  if (byKnown) return { candidate: byKnown, reason: "known-id" };
  const byRunning = candidates.find((c) => c.service.hasRunning?.() === true);
  if (byRunning) return { candidate: byRunning, reason: "hasRunning" };
  return { candidate: candidates[0], reason: candidates[0].source.startsWith("held:") ? "held-first" : "live-only" };
}

/** Import the package's public entry: plain specifier first, then the Pi npm directory entry. */
async function loadService(): Promise<{ service: KillService | undefined; source: string }> {
  const specifiers: string[] = ["@gotgenes/pi-subagents"];
  try {
    const req = createRequire(join(homedir(), "subagents-kill-resolve.js"));
    specifiers.push(req.resolve("@gotgenes/pi-subagents", { paths: [join(homedir(), ".pi/agent/npm/node_modules")] }));
  } catch {
    // The package is not installed there; the plain specifier may still work.
  }
  for (let i = 0; i < specifiers.length; i++) {
    const specifier = specifiers[i];
    try {
      const mod = (await import(specifier)) as ServiceModule | undefined;
      if (mod && typeof mod.getSubagentsService === "function") {
        return { service: mod.getSubagentsService(), source: `import[${i}]:${specifier.slice(0, 120)}` };
      }
    } catch {
      // try the next candidate
    }
  }
  return { service: undefined, source: "unresolved" };
}

/** Selector over `records`; allowAll adds an "All active agents" choice. Returns [] on cancel. */
async function choose(
  ctx: ExtensionCommandContext,
  records: KillRecord[],
  allowAll: boolean,
): Promise<KillRecord[] | undefined> {
  const byLabel = new Map<string, KillRecord>();
  const options: string[] = [];
  for (const r of records) {
    let label = labelOf(r);
    while (byLabel.has(label)) label = `${label} [${r.id}]`; // id collision: disambiguate with the full id
    byLabel.set(label, r);
    options.push(label);
  }
  if (allowAll) options.push("All active agents");
  options.push("Cancel");
  const choice = await ctx.ui.select("Abort which subagent?", options);
  if (choice === undefined || choice === "Cancel") return undefined;
  if (choice === "All active agents") return records;
  const picked = byLabel.get(choice);
  return picked ? [picked] : undefined;
}

export default function (pi: ExtensionAPI, deps: KillDeps = {}): void {
  const log = deps.log ?? defaultLog;

  // Track ids spawned through this runtime (parent bus only — child runtimes
  // have their own ExtensionAPI): only the parent adapter can resolve them.
  for (const event of ["subagents:started", "subagents:created", "subagents:resuming"]) {
    pi.events.on(event, (data: unknown) => {
      const id = (data as { id?: unknown } | undefined)?.id;
      if (typeof id === "string") knownParentIds.add(id);
    });
  }

  let held: ServiceCandidate | undefined;
  const captureHeld = async (): Promise<void> => {
    if (deps.getService) return;
    const { service, source } = await loadService();
    if (service) held = { service, source: `held:${source}` };
  };
  // At load no child exists yet right after a reload, so the captured adapter is
  // the parent's; session_start refreshes it (and drops stale ids — records are
  // cleared at session start).
  void captureHeld();
  pi.on("session_start", async () => {
    knownParentIds.clear();
    await captureHeld();
  });

  pi.registerCommand("subagents-kill", {
    description: "Abort running or queued subagents (interactive picker with no argument)",
    handler: async (args, ctx) => {
      let service: KillService | undefined;
      let source: string;
      let reason: SelectReason;
      if (deps.getService) {
        service = await deps.getService();
        source = "deps.getService";
        reason = "deps";
      } else {
        const live = await loadService();
        const candidates: ServiceCandidate[] = [];
        if (held) candidates.push(held);
        if (live.service && live.service !== held?.service) {
          candidates.push({ service: live.service, source: live.source });
        }
        const picked = selectService(candidates, knownParentIds);
        service = picked.candidate?.service;
        source = picked.candidate?.source ?? live.source;
        reason = picked.reason;
      }

      if (!service) {
        log({ event: "resolve", args, mode: ctx.mode, source, reason, heldPresent: held !== undefined, service: undefined });
        return ctx.ui.notify("pi-subagents service unavailable (extension not loaded?).", "error");
      }

      const all = service.listAgents();
      const active = all.filter((r) => ACTIVE.has(r.status));
      log({
        event: "resolve",
        args,
        mode: ctx.mode,
        hasUI: ctx.hasUI,
        source,
        reason,
        heldPresent: held !== undefined,
        knownIds: knownParentIds.size,
        serviceId: serviceIdOf(service),
        ctor: service.constructor?.name,
        hasRunning: typeof service.hasRunning === "function" ? service.hasRunning() : undefined,
        recordCount: all.length,
        records: all.map((r) => `${r.id}:${r.status}`),
        activeCount: active.length,
      });
      if (active.length === 0) {
        return ctx.ui.notify("No running or queued subagents.", "info");
      }

      // Resolve the targets: explicit arg first, otherwise the picker.
      const arg = args.trim();
      let targets: KillRecord[];
      if (arg === "all") {
        targets = active;
      } else if (arg) {
        const exact = active.filter((r) => r.id === arg);
        const matches = exact.length > 0 ? exact : active.filter((r) => r.id.startsWith(arg));
        if (matches.length === 0) {
          return ctx.ui.notify(`No running or queued subagent matches "${arg}". (Settled agents cannot be aborted.)`, "info");
        }
        if (matches.length === 1) {
          targets = matches;
        } else if (ctx.hasUI) {
          const picked = await choose(ctx, matches, false);
          if (!picked) return;
          targets = picked;
        } else {
          return ctx.ui.notify(`Ambiguous id "${arg}" (${matches.length} matches); pass a full id.`, "info");
        }
      } else if (ctx.hasUI) {
        if (active.length === 1) {
          targets = active;
        } else {
          const picked = await choose(ctx, active, true);
          if (!picked) return;
          targets = picked;
        }
      } else {
        return ctx.ui.notify("Usage: /subagents-kill all|<id> (no interactive picker in this mode).", "info");
      }

      const title =
        targets.length === 1
          ? `Abort subagent ${shortId(targets[0].id)} (${targets[0].status})?`
          : `Abort all ${targets.length} active subagents?`;
      const detail =
        targets.length === 1
          ? `${targets[0].type} — ${clip(targets[0].description)}\n\nThe run stops and its result is not collected.`
          : targets.map((r) => `• ${labelOf(r)}`).join("\n");
      if (ctx.hasUI && !(await ctx.ui.confirm(title, detail))) {
        log({ event: "outcome", args, decision: "confirm-declined", targets: targets.map((r) => r.id) });
        return;
      }

      let aborted = 0;
      const notAborted: string[] = [];
      for (const r of targets) {
        try {
          if (service.abort(r.id)) aborted++;
          else notAborted.push(shortId(r.id));
        } catch {
          notAborted.push(shortId(r.id));
        }
      }
      log({
        event: "outcome",
        args,
        targets: targets.map((r) => r.id),
        aborted,
        notAborted,
        notify: notAborted.length === 0 ? `Aborted ${aborted} subagent${plural(aborted)}.` : "partial",
      });
      if (notAborted.length === 0) {
        return ctx.ui.notify(`Aborted ${aborted} subagent${plural(aborted)}.`, "info");
      }
      return ctx.ui.notify(
        `Aborted ${aborted}/${targets.length} subagents (not abortable: ${notAborted.join(", ")}).`,
        "warning",
      );
    },
  });
}
