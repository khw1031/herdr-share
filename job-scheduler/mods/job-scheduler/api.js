// Local file request/receipt bridge. All writes go through the running mod, never shared.json.
import { appHome, readTextFile, writeTextFile, shared, setShared, exec } from "herdr";
import { loadJobs, saveJobs, nextSlot, TIME_RE, DATE_RE, installMachineJob, uninstallMachineJob } from "./core.js";
import { readAllCatalogs } from "./catalog.js";
const LOCK = "job-scheduler/api-lock";
const VERSION = "job-scheduler/version";
export const version = () => shared(VERSION) ?? 0;
const fail = (message) => { throw new Error(message); };
const summary = (job) => ({ ...job, task: undefined, taskLength: job.task.length, nextRunAt: job.enabled && !job.done ? nextSlot(job, Date.now()) : null });
export const snapshot = () => ({ version: version(), jobs: loadJobs().map(summary), machineOffsetMinutes: -new Date().getTimezoneOffset() });

async function validate(input) {
  if (!input || typeof input !== "object") fail("job must be an object");
  for (const key of Object.keys(input)) if (!["name","machine","type","time","days","date","mode","folder","agent","task","enabled","timezone"].includes(key)) fail(`unknown job field: ${key}`);
  for (const key of ["name","folder","agent","task"]) if (typeof input[key] !== "string" || !input[key].trim()) fail(`${key} is required`);
  if (input.name.length > 120 || input.task.length > 100000) fail("name/task too long");
  if (input.machine !== null && typeof input.machine !== "string") fail("machine must be null or a configured name");
  if (!["app","machine"].includes(input.mode)) fail("mode must be app or machine");
  if (!["repeat","once"].includes(input.type) || !TIME_RE.test(input.time)) fail("invalid type/time");
  if (typeof input.enabled !== "boolean") fail("enabled must be boolean");
  if (input.type === "repeat") {
    if (!Array.isArray(input.days) || !input.days.length || new Set(input.days).size !== input.days.length || input.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) fail("days must be unique integers 0..6");
  } else {
    if (!DATE_RE.test(input.date)) fail("date must be YYYY-MM-DD");
    const when = new Date(`${input.date}T${input.time}:00`);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now() || `${when.getFullYear()}-${String(when.getMonth()+1).padStart(2,"0")}-${String(when.getDate()).padStart(2,"0")}` !== input.date) fail("invalid or past one-time date");
  }
  if (/\s--(?:dangerously-bypass|permission-mode\s+bypassPermissions)/.test(input.agent)) fail("approval bypass flags are not supported");
  if (/(^|\/)codex(?:\s|$)/.test(input.agent) && !input.agent.split(/\s+/).includes("--no-daemon")) fail("Codex requires --no-daemon in Herdr");
  if (input.timezone) {
    if (!/^[A-Za-z0-9_+\-/]+$/.test(input.timezone)) fail("invalid timezone");
    const actual = await exec("date", ["+%z"], {on:input.machine,timeout:15000});
    const wanted = await exec("env", [`TZ=${input.timezone}`, "date", "+%z"], {on:input.machine,timeout:15000});
    if (actual.code || wanted.code || actual.stdout.trim() !== wanted.stdout.trim()) fail("execution machine timezone differs; no time conversion was applied");
  }
  const r = await exec("sh", ["-c", 'p="$1"; case "$p" in "~"|"~/"*) p="$HOME${p#"~"}";; esac; [ -d "$p" ] && cd "$p" && pwd -P', "sh", input.folder], {on:input.machine,timeout:15000});
  if (r.code || !r.stdout.trim()) fail(`folder does not exist on execution machine: ${input.folder}`);
  return {...input,folder:r.stdout.trim(),...(input.type === "repeat" ? {days:[...input.days].sort()} : {})};
}

// The same transaction is used by the screen and external callers.
export async function mutate(action, id, input, expectedVersion) {
  if (shared(LOCK)) fail("another scheduler request is in progress; retry after reading the list");
  setShared(LOCK, {at:Date.now(),action});
  try {
    if (expectedVersion !== version()) fail("version conflict; read the list again");
    let list = loadJobs();
    const old = id ? list.find(j => j.id === id) : null;
    if (action !== "add" && !old) fail("job not found");
    let next;
    if (action === "add" || action === "update") {
      if (old && (input.machine !== undefined && input.machine !== old.machine || input.mode !== undefined && input.mode !== old.mode)) fail("moving machine/mode requires a separate new job");
      const existingInput = old ? Object.fromEntries(Object.entries(old).filter(([key]) => ["name","machine","type","time","days","date","mode","folder","agent","task","enabled","timezone"].includes(key))) : {};
      const data = await validate({...existingInput,...input});
      if (action === "add" && list.some(j => j.name === data.name && (j.machine ?? null) === data.machine)) fail("duplicate name on this machine; use update with its ID");
      next = old ? {...old,...data,updatedAt:Date.now()} : {...data,id:`job-${Date.now()}`,createdAt:Date.now(),lastSlot:null,lastRunAt:null};
      if (old && (old.time !== next.time || old.date !== next.date || JSON.stringify(old.days) !== JSON.stringify(next.days))) { next.lastSlot=null;next.done=false; }
    } else if (action === "enable" || action === "disable") {
      next = {...old,enabled:action === "enable",...(action === "enable" ? {done:false} : {}),updatedAt:Date.now()};
      if (action === "enable") await validate(Object.fromEntries(Object.entries(next).filter(([key]) => ["name","machine","type","time","days","date","mode","folder","agent","task","enabled","timezone"].includes(key))));
    } else if (action !== "remove") fail("action must be add, update, enable, disable or remove");
    // Folder/timezone checks await external work. Reject concurrent screen changes before side effects.
    if (expectedVersion !== version()) fail("version conflict; read the list again");
    if (old?.mode === "machine" && (action === "remove" || !next.enabled)) await uninstallMachineJob(old);
    else if (next?.mode === "machine" && next.enabled) await installMachineJob(next);
    list = loadJobs();
    saveJobs(action === "add" ? [...list,next] : action === "remove" ? list.filter(j => j.id !== id) : list.map(j => j.id === id ? next : j));
    return {version:version(),job:next ? summary(next) : null,removed:action === "remove" ? id : undefined};
  } finally { setShared(LOCK,null); }
}

export async function handleRequest(token) {
  if (!/^[a-f0-9]{32}$/.test(token)) return;
  const base = `${appHome()}/job-scheduler-api/${token}`;
  if (await readTextFile(`${base}.response.json`)) return;
  // Copies may receive the same command. Claim synchronously after the first asynchronous read.
  const claim = "job-scheduler/api-claim";
  const active=shared(claim);
  if (active === token) return;
  if (active) {
    await writeTextFile(`${base}.response.json`,JSON.stringify({ok:false,request_id:token,error:"another API request is in progress"})+"\n",null);
    return;
  }
  setShared(claim,token);
  let result;
  try {
    const request = JSON.parse(await readTextFile(`${base}.request.json`) || "null");
    if (!request || request.request_id !== token || request.protocol !== 1) fail("invalid scheduler request");
    if (request.action === "list") result=snapshot();
    else if (request.action === "catalog") result={...snapshot(),remoteApps:await readAllCatalogs()};
    else if (request.action === "get") {
      const job=loadJobs().find(j=>j.id===request.id);if(!job) fail("job not found");
      result={version:version(),job,nextRunAt:job.enabled && !job.done ? nextSlot(job,Date.now()) : null};
    } else result=await mutate(request.action,request.id,request.job,request.expectedVersion);
    result={ok:true,request_id:token,...result};
  } catch (e) { result={ok:false,request_id:token,error:String(e?.message ?? e)}; }
  try { await writeTextFile(`${base}.response.json`,JSON.stringify(result)+"\n",null); }
  finally { setShared(claim,null); }
}
