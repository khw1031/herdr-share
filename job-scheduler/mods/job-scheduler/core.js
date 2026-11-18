// Shared scheduled-job logic: saving jobs, computing run times, running, machine mode (crontab), opening the detail tab.
// Run mode (mode)
//   app     — at the time, this mod's timer starts the job as a new tab in that machine's Jobs space (the app must be open)
//   machine — at the time, that machine's crontab starts it with `hc run --bg` (runs even when the app is closed)
// Type (type): repeat (time + days) / once (date + time, done after one run)
import { spaces, panes, terminals, run, exec, notify, shared, setShared } from "herdr";

export const JOBS_KEY = "job-scheduler/jobs";
export const RUNS_KEY = "job-scheduler/runs";
export const FOCUS_KEY = "job-scheduler/focus";
export const SPACE_NAME = "Jobs";
export const DETAIL_MOD = "job-scheduler";
export const TICK_MS = 30_000;
export const GRACE_MS = 10 * 60_000; // still runs if the app opens up to 10 minutes late (app mode)
export const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const STATUS_TEXT = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };

export const pad = (n) => String(n).padStart(2, "0");
export const machineKey = (m) => m ?? "";
export const machineLabel = (m) => (m ? m : "This computer");
export const modeOf = (j) => (j.mode === "machine" ? "machine" : "app");
export const isOnce = (j) => j.type === "once";
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function fmt(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}.${pad(d.getDate())}(${DAYS[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function loadJobs() {
  const v = shared(JOBS_KEY);
  return Array.isArray(v) ? v : [];
}
export function saveJobs(list) {
  setShared("job-scheduler/version", (shared("job-scheduler/version") ?? 0) + 1);
  setShared(JOBS_KEY, list);
}
export function patchJob(id, patch) {
  saveJobs(loadJobs().map((j) => (j.id === id ? { ...j, ...patch } : j)));
}
export function loadRuns() {
  const v = shared(RUNS_KEY);
  return Array.isArray(v) ? v : [];
}

function at(dateStr, time) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, m] = time.split(":").map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0).getTime();
}
function slotOn(job, base, offsetDays) {
  const [h, m] = job.time.split(":").map(Number);
  const d = new Date(base);
  d.setDate(d.getDate() + offsetDays);
  d.setHours(h, m, 0, 0);
  return d;
}
/** The latest scheduled time at or before now */
export function lastSlot(job, now) {
  if (isOnce(job)) {
    const t = at(job.date, job.time);
    return t <= now ? t : null;
  }
  for (let back = 0; back <= 7; back++) {
    const d = slotOn(job, now, -back);
    if (d.getTime() <= now && job.days.includes(d.getDay())) return d.getTime();
  }
  return null;
}
/** The next scheduled time after now */
export function nextSlot(job, now) {
  if (isOnce(job)) {
    if (job.done) return null;
    const t = at(job.date, job.time);
    return t > now ? t : null;
  }
  for (let ahead = 0; ahead <= 7; ahead++) {
    const d = slotOn(job, now, ahead);
    if (d.getTime() > now && job.days.includes(d.getDay())) return d.getTime();
  }
  return null;
}
/** A scheduled time that passed without a run (app mode, past the grace period) */
export function missedSlot(job, now) {
  if (!job.enabled || job.done || modeOf(job) !== "app") return null;
  const slot = lastSlot(job, now);
  if (!slot || slot === job.lastSlot || slot < (job.createdAt ?? 0)) return null;
  return now - slot > GRACE_MS ? slot : null;
}

export function findJobsSpace(machine) {
  return spaces().find((s) => s.named && s.name === SPACE_NAME && (s.machine ?? null) === (machine ?? null));
}

// ---------- Finding a run's result ----------

/** Terminal name a machine-mode run gives: j<last 6 digits of the id>-<MMDDhhmm> */
export const runNamePrefix = (job) => `j${job.id.replace(/\D/g, "").slice(-6)}-`;

/** The agent this job started last: { status, open() } or null */
export function liveFor(job) {
  if (modeOf(job) === "machine") {
    const prefix = runNamePrefix(job);
    const list = terminals().filter((t) => typeof t.name === "string" && t.name.startsWith(prefix));
    const term = list.sort((a, b) => String(a.name).localeCompare(String(b.name))).pop();
    if (!term) return null;
    return {
      status: term.status ?? (term.state === "finished" ? "done" : null),
      open: () => run("terminal.keep", { terminal: term.address, place: "tab" }),
    };
  }
  const space = findJobsSpace(job.machine);
  const tab = space?.tabs.filter((t) => t.name === job.name).pop();
  if (!tab) return null;
  return {
    status: tab.status ?? null,
    open: () => { run("space.select", { id: space.id }); run("tab.select", { id: tab.id }); },
  };
}

// ---------- Running in app mode ----------

/** Start the job as a tab now. slot: the scheduled time for a scheduled run, null for a manual run. */
export function fireJob(job, slot) {
  const list = loadJobs();
  const cur = list.find((j) => j.id === job.id);
  if (!cur) return false;
  if (slot !== null && cur.lastSlot === slot) return false; // another copy already ran it
  const startedAt = Date.now();
  const doneOnce = slot !== null && isOnce(cur);
  saveJobs(list.map((j) => (j.id === job.id
    ? { ...j, lastSlot: slot ?? j.lastSlot, lastRunAt: startedAt, ...(doneOnce ? { done: true, enabled: false } : {}) }
    : j)));

  const argv = (cur.agent || "claude").trim().split(/\s+/);
  const folder = cur.folder?.trim() || undefined;
  const space = findJobsSpace(cur.machine);
  if (space) {
    run("tab.new", { space: space.id, name: cur.name, folder, argv, task: cur.task, focus: false });
  } else {
    run("space.new", { name: SPACE_NAME, tab: cur.name, folder, argv, task: cur.task, machine: cur.machine ?? "", focus: false });
  }
  const runs = [{ id: cur.id, name: cur.name, machine: cur.machine ?? null, at: startedAt, manual: slot === null }, ...loadRuns()].slice(0, 30);
  setShared(RUNS_KEY, runs);
  notify({
    title: `Job started: ${cur.name}`,
    body: `${machineLabel(cur.machine)} · ${argv.join(" ")}`,
    level: "info",
    timeout: 6000,
    ...(space ? { action: { name: "space.select", args: { id: space.id } } } : {}),
  });
  return true;
}

/** Run the app-mode jobs whose time has come. Within one tick a machine's Jobs space is created only once. */
export function tickJobs(now = Date.now()) {
  const creating = new Set();
  let fired = 0;
  for (const job of loadJobs()) {
    // One-time machine-mode job: macOS cron cannot edit its own crontab (Operation not permitted),
    // so once the time has passed the app removes the line and marks the job done
    if (modeOf(job) === "machine" && isOnce(job) && !job.done) {
      const t = lastSlot(job, now);
      if (t && now - t > 90_000) {
        patchJob(job.id, { done: true, enabled: false, lastRunAt: t });
        uninstallMachineJob(job).catch(() => {});
      }
      continue;
    }
    if (!job.enabled || job.done || modeOf(job) !== "app") continue;
    const slot = lastSlot(job, now);
    if (!slot || slot === job.lastSlot || slot < (job.createdAt ?? 0)) continue;
    if (now - slot > GRACE_MS) continue;
    const key = machineKey(job.machine);
    if (creating.has(key)) continue;
    if (!findJobsSpace(job.machine)) creating.add(key);
    if (fireJob(job, slot)) fired++;
  }
  return fired;
}

// ---------- Machine mode (crontab + ~/.herdr-jobs/<id>.sh) ----------

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const tag = (job) => `# herdr-job:${job.id}`;

function buildScript(job) {
  const argv = (job.agent || "claude").trim().split(/\s+/).map(sq).join(" ");
  const lines = [
    "#!/bin/sh",
    `# herdr-job:${job.id} ${job.name.replace(/\n/g, " ")} (file made by the job-scheduler mod)`,
  ];
  if (isOnce(job)) lines.push(`[ "$(date +%Y-%m-%d)" = ${sq(job.date)} ] || exit 0`);
  lines.push(
    `NAME=${sq(runNamePrefix(job))}"$(date +%m%d%H%M)"`,
    `"$HOME/.local/bin/hc" run --bg --no-parent --name "$NAME" --cwd ${sq(job.folder)} ${argv} ${sq(job.task)} >>"$HOME/.herdr-jobs/${job.id}.log" 2>&1`,
  );
  if (isOnce(job)) {
    lines.push(
      `crontab -l 2>/dev/null | grep -v ${sq(`${tag(job)}$`)} | crontab -`,
      `rm -f "$0"`,
    );
  }
  return lines.join("\n") + "\n";
}

function cronLine(job) {
  const [h, m] = job.time.split(":").map(Number);
  let when;
  if (isOnce(job)) {
    const [, mo, d] = job.date.split("-").map(Number);
    when = `${m} ${h} ${d} ${mo} *`;
  } else {
    when = `${m} ${h} * * ${job.days.length === 7 ? "*" : [...job.days].sort().join(",")}`;
  }
  return `${when} /bin/sh "$HOME/.herdr-jobs/${job.id}.sh" ${tag(job)}`;
}

/** Install the schedule on that machine (write the script, add one crontab line). Throws on failure. */
export async function installMachineJob(job) {
  const on = job.machine ?? null;
  const write = await exec("sh", ["-c",
    'mkdir -p "$HOME/.herdr-jobs" && printf "%s" "$1" > "$HOME/.herdr-jobs/$2.sh" && chmod 700 "$HOME/.herdr-jobs/$2.sh"',
    "sh", buildScript(job), job.id], { on, timeout: 20_000 });
  if (write.code !== 0) throw new Error(write.stderr.trim() || "could not write the script");
  const cron = await exec("sh", ["-c",
    '{ crontab -l 2>/dev/null | grep -v "# herdr-job:$1\\$"; printf "%s\\n" "$2"; } | crontab -',
    "sh", job.id, cronLine(job)], { on, timeout: 20_000 });
  if (cron.code !== 0) throw new Error(cron.stderr.trim() || "could not add the crontab line");
}

/** Remove the schedule from that machine (its crontab line and script). */
export async function uninstallMachineJob(job) {
  const on = job.machine ?? null;
  const r = await exec("sh", ["-c",
    '{ crontab -l 2>/dev/null | grep -v "# herdr-job:$1\\$"; } | crontab - && rm -f "$HOME/.herdr-jobs/$1.sh"',
    "sh", job.id], { on, timeout: 20_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "could not remove the schedule");
}

/** Whether this job's line is still in the machine's crontab text */
export const isInstalledIn = (cronLines, job) => (cronLines ?? []).some((l) => l.includes(tag(job)));

/** Open the detail tab or go to it. job: the job id to show, form: open the add form */
export function openDetail({ job = null, machine, form = false } = {}) {
  setShared(FOCUS_KEY, { job, machine: machine ?? null, form, at: Date.now() });
  const pane = panes().find((p) => p.mod === DETAIL_MOD);
  if (pane) {
    const space = spaces().find((s) => s.tabs.some((t) => t.id === pane.tab));
    if (space) run("space.select", { id: space.id });
    run("tab.select", { id: pane.tab });
    return;
  }
  run("tab.new", { mod: DETAIL_MOD, name: "Scheduled jobs" });
}
