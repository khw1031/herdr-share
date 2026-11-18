// Scheduled jobs detail tab: jobs per machine (list, add, run, status), the machine's crontab (read-only), recent runs.
// The sidebar button (view: "sidebar") brings you to this tab.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { machines, exec, shared, theme, checking, nextCommand, home, props } from "herdr";
import { renderSidebar } from "./sidebar.js";
import { handleRequest, mutate, version } from "./api.js";
import { readCatalog, CATALOG_REFRESH_MS } from "./catalog.js";
import {
  FOCUS_KEY, TICK_MS, DAYS, ALL_DAYS, TIME_RE, DATE_RE, STATUS_TEXT, fmt, ymd, machineKey, machineLabel, modeOf, isOnce,
  loadJobs, saveJobs, patchJob, loadRuns, nextSlot, missedSlot, liveFor, fireJob, tickJobs,
  installMachineJob, uninstallMachineJob, isInstalledIn,
} from "./core.js";

export default class JobScheduler extends View {
  init(_props, cx) {
    this.view = props()?.view === "sidebar" ? "sidebar" : "detail";
    if (this.view === "sidebar") {
      if (checking()) return;
      cx.timer.every(TICK_MS, (cx) => { tickJobs(); cx.notify(); });
      tickJobs();
      cx.spawn(async (cx) => { for (;;) {
        const c = await nextCommand();
        if (c.startsWith("api:")) await handleRequest(c.slice(4));
        else if (c === "tick") tickJobs();
        cx.notify();
      } });
      return;
    }
    this.selected = "*";
    this.formMachine = "";
    this.catalogs = {};
    this.catalogAt = 0;
    this.highlight = null;
    this.focusSeen = 0;
    this.formOpen = false;
    this.error = "";
    this.busy = {};
    this.cron = {};
    this.days = [...ALL_DAYS];
    this.type = "repeat";
    this.mode = "app";
    const tomorrow = new Date(Date.now() + 86_400_000);
    this.inName = InputState.new({ placeholder: "e.g. Morning PR review" });
    this.inTime = InputState.new({ placeholder: "09:00", value: "09:00" });
    this.inDate = InputState.new({ placeholder: "YYYY-MM-DD", value: ymd(tomorrow) });
    this.inFolder = InputState.new({ placeholder: "A project folder you already trust (e.g. ~/projects/my-app)" });
    this.inAgent = InputState.new({ placeholder: "claude", value: "claude" });
    this.inTask = TextareaState.new({ placeholder: "The first message for the agent", rows: 3 });
    if (checking()) return;
    cx.timer.every(TICK_MS, (cx) => { tickJobs(); this.refreshCatalogs(cx); cx.notify(); });
    tickJobs();
    this.refreshCatalogs(cx, true);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c.startsWith("api:")) await handleRequest(c.slice(4));
        else if (c === "tick") tickJobs();
        cx.notify();
      }
    });
  }

  /** Check the form → resolve the folder to an absolute path on that machine → (machine mode: add the crontab line) → save */
  saveForm(cx) {
    const name = this.inName.value().trim();
    const time = this.inTime.value().trim();
    const date = this.inDate.value().trim();
    const task = this.inTask.value().trim();
    const folder = this.inFolder.value().trim();
    const machine = this.formMachine || null;
    const fail = (msg) => { this.error = msg; cx.notify(); };
    if (!name) return fail("Enter a name.");
    if (!TIME_RE.test(time)) return fail("Enter the time as HH:MM (24-hour).");
    if (this.type === "once") {
      if (!DATE_RE.test(date)) return fail("Enter the date as YYYY-MM-DD.");
      const [y, mo, d] = date.split("-").map(Number);
      const [h, m] = time.split(":").map(Number);
      if (new Date(y, mo - 1, d, h, m).getTime() <= Date.now()) return fail("That one-time run is already in the past.");
    } else if (this.days.length === 0) return fail("Pick at least one day.");
    if (!folder) return fail("Enter a folder. In the home folder Claude stops every time to ask whether to trust the folder.");
    if (!task) return fail("Enter the task for the agent.");
    this.error = this.mode === "machine" ? "Checking the folder and adding the schedule…" : "Checking the folder…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await mutate("add", null, {
          name, machine, type:this.type, time,
          ...(this.type === "once" ? {date} : {days:[...this.days]}),
          mode:this.mode,folder,agent:this.inAgent.value().trim() || "claude",task,enabled:true,
        }, version());
        this.error = "";
        this.formOpen = false;
        this.selected = "";
        this.inName.set_value("");
        this.inTask.set_value("");
        this.refreshCron(cx, "");
      } catch (e) {
        this.error = `Could not save (${machineLabel(machine)}): ${String(e?.message ?? e)}`;
      }
      cx.notify();
    });
  }

  /** Turn on/off or delete. A machine-mode job changes that machine's crontab too. */
  change(cx, job, action) {
    this.busy[job.id] = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await mutate(action === "delete" ? "remove" : action, job.id, null, version());
        this.error = "";
      } catch (e) {
        this.error = `${job.name}: ${String(e?.message ?? e)}`;
      }
      delete this.busy[job.id];
      this.refreshCron(cx, machineKey(job.machine));
      cx.notify();
    });
  }

  refreshCatalogs(cx, force = false) {
    if (!force && Date.now() - this.catalogAt < CATALOG_REFRESH_MS) return;
    this.catalogAt = Date.now();
    for (const machine of machines().filter(m => m.name)) {
      const key=machine.name;
      if (this.catalogs[key]?.loading) continue;
      this.catalogs[key]={...this.catalogs[key],loading:true};
      cx.spawn(async (cx) => {
        const result=await readCatalog(key);
        const previous=this.catalogs[key];
        this.catalogs[key]={...result,jobs:result.jobs ?? previous?.jobs ?? null,loading:false,stale:Boolean(result.error && previous?.jobs)};
        cx.notify();
      });
    }
  }

  refreshCron(cx, key) {
    if (key === "*") return;
    this.cron[key] = { ...(this.cron[key] ?? {}), loading: true };
    cx.spawn(async (cx) => {
      try {
        const r = await exec("crontab", ["-l"], { on: key || null, timeout: 15_000 });
        const lines = (r.stdout || "").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
        this.cron[key] = { lines, empty: lines.length === 0 };
      } catch (e) {
        this.cron[key] = { error: String(e?.message ?? e) };
      }
      cx.notify();
    });
  }

  /** Apply a request from the sidebar (show a job / open the add form) */
  applyFocus(cx) {
    const f = shared(FOCUS_KEY);
    if (!f || !f.at || f.at <= this.focusSeen) return;
    this.focusSeen = f.at;
    const job = f.job ? loadJobs().find((j) => j.id === f.job) : null;
    const key = job || f.form ? "" : this.selected;
    if (key !== this.selected) { this.selected = key; this.refreshCron(cx, key); }
    this.highlight = job?.id ?? null;
    if (f.form) { this.formMachine=machineKey(f.machine);this.formOpen=true; }
  }

  render(cx) {
    if (this.view === "sidebar") return renderSidebar();
    this.applyFocus(cx);
    const t = theme();
    const now = Date.now();
    const jobs = loadJobs();
    const runs = loadRuns();
    const mine = this.selected === "*" || this.selected === "" ? jobs : [];
    const cron = this.cron[this.selected] ?? {};

    const button = (id, text, primary, action) =>
      h_flex().id(id).h(28).px(10).items_center().rounded(7).border_1()
        .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
        .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).cursor_pointer()
        .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    const label = (text) => div().pt(10).pb(4).text_size(11.5).text_color(t.dim).child(text);
    const hint = (text) => div().pt(4).text_size(11).text_color(t.dim).child(text);
    const field = (state) =>
      Input.new(state).h(32).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground);
    const chip = (id, text, on, action, w) => {
      const el = div().id(id).h(28).px(10).flex().items_center().justify_center().rounded(7).cursor_pointer()
        .border_1().border_color(on ? t.accent : t.input).bg(on ? t.selected : t.background)
        .text_size(12).text_color(on ? t.foreground : t.muted).on_click(action).child(text);
      return w ? el.w(w).px(0) : el;
    };
    const badge = (text, strong) => div().px(6).py(1).rounded(5).text_size(11)
      .bg(strong ? t.selected : t.raised).text_color(strong ? t.foreground : t.dim).child(text);

    const machineTabs = h_flex().gap(6).flex_wrap()
      .child(chip("catalog-all", "All", this.selected === "*", (_e,cx)=>{this.selected="*";this.formOpen=false;cx.notify();}))
      .children(
      machines().map((m) => {
        const key = machineKey(m.name);
        const active = key === this.selected;
        const catalog=this.catalogs[key];
        const count = !key ? String(jobs.length) : catalog?.error ? "read failed" : catalog?.loading || !catalog ? "…" : String(catalog.jobs?.length ?? 0);
        const dot = m.layout === "ready" ? t.done : m.layout === "loading" ? t.working : t.blocked;
        return h_flex().id(`mt-${key || "local"}`).h(30).px(12).gap(6).items_center().rounded(8).cursor_pointer()
          .border_1().border_color(active ? t.accent : t.border).bg(active ? t.selected : t.raised)
          .on_click((_e, cx) => { this.selected = key; this.formOpen = false; this.highlight = null; this.error = ""; this.refreshCron(cx, key); this.refreshCatalogs(cx); cx.notify(); })
          .child(div().w(7).h(7).rounded(4).bg(dot))
          .child(div().text_size(12.5).font_medium().child(machineLabel(m.name)))
          .child(div().text_size(11).text_color(t.dim).child(String(count)));
      }),
    );

    const dayChips = h_flex().gap(4).children(
      ALL_DAYS.map((d) => {
        const on = this.days.includes(d);
        return chip(`day-${d}`, DAYS[d], on, (_e, cx) => { this.days = on ? this.days.filter((x) => x !== d) : [...this.days, d]; cx.notify(); }, 30);
      }),
    );

    const form = v_flex().p(14).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(div().text_size(13).font_semibold().child(`Saved in: This computer · Runs on: ${machineLabel(this.formMachine || null)}`))
      .child(label("Name")).child(field(this.inName))
      .child(label("Type"))
      .child(h_flex().gap(6)
        .child(chip("type-repeat", "Repeat", this.type === "repeat", (_e, cx) => { this.type = "repeat"; cx.notify(); }))
        .child(chip("type-once", "Once", this.type === "once", (_e, cx) => { this.type = "once"; cx.notify(); })))
      .child(h_flex().gap(12)
        .when(this.type === "once", (el) => el.child(v_flex().w(130).child(label("Date")).child(field(this.inDate))))
        .child(v_flex().w(110).child(label("Time (HH:MM)")).child(field(this.inTime)))
        .when(this.type === "repeat", (el) => el.child(v_flex().child(label("Days")).child(dayChips))))
      .child(label("Run mode"))
      .child(h_flex().gap(6)
        .child(chip("mode-app", "App", this.mode === "app", (_e, cx) => { this.mode = "app"; cx.notify(); }))
        .child(chip("mode-machine", "Machine", this.mode === "machine", (_e, cx) => { this.mode = "machine"; cx.notify(); })))
      .child(hint(this.mode === "app"
        ? "While the app is open, the scheduler's timer starts the job as a new tab in the Jobs space. If the app is closed the run is missed (it still runs if the app opens within 10 minutes)."
        : `${machineLabel(this.formMachine || null)}'s crontab starts it at that time with \`hc run --bg\`. It runs even when the app is closed, and the result shows in the agents list.`))
      .child(label("Folder (required)")).child(field(this.inFolder))
      .child(hint("An agent stops at the trust prompt in a folder it has never opened. Use a folder you have opened and trusted yourself."))
      .child(label("Agent command")).child(field(this.inAgent))
      .child(label("Task (first message)"))
      .child(Textarea.new(this.inTask).h(76).p(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
      .when(Boolean(this.error), (el) => el.child(div().pt(8).text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().pt(12).gap(8).justify_end()
        .child(button("form-cancel", "Cancel", false, (_e, cx) => { this.formOpen = false; this.error = ""; cx.notify(); }))
        .child(button("form-save", "Save", true, (_e, cx) => this.saveForm(cx))));

    const jobCard = (j) => {
      const machineMode = modeOf(j) === "machine";
      const next = j.enabled ? nextSlot(j, now) : null;
      const missed = missedSlot(j, now);
      const when = isOnce(j) ? `Once ${j.date} ${j.time}` : `${j.days.length === 7 ? "Daily" : j.days.map((d) => DAYS[d]).join("")} ${j.time}`;
      const live = liveFor(j);
      const st = live?.status ?? null;
      const stText = STATUS_TEXT[st] ?? (live ? "Started" : null);
      const stColor = { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle }[st] ?? t.dim;
      const installed = machineMode && machineKey(j.machine) === this.selected && !cron.error && cron.lines ? isInstalledIn(cron.lines, j) : null;
      const busy = Boolean(this.busy[j.id]);
      const state = j.done ? "Done" : j.enabled ? "On" : "Off";
      return v_flex().p(12).gap(4).rounded(10).border_1().border_color(this.highlight === j.id ? t.accent : t.border).bg(t.surface)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().truncate().text_size(13.5).font_semibold().text_color(j.enabled ? t.foreground : t.muted).child(j.name))
          .child(badge(machineMode ? "Machine" : "App", false))
          .child(badge(state, j.enabled && !j.done)))
        .child(div().text_size(12).text_color(t.muted).child(
          `${when} · next ${fmt(next)}${machineMode ? "" : ` · last run ${fmt(j.lastRunAt)}`}`))
        .when(machineMode && j.enabled && installed === false, (el) =>
          el.child(div().text_size(12).text_color(t.blocked).child("Not in this machine's crontab (Turn off → Turn on adds it again)")))
        .when(machineMode && installed === true, (el) =>
          el.child(div().text_size(12).text_color(t.dim).child(`In crontab${isOnce(j) ? " · removes itself after it runs" : ""}`)))
        .when(Boolean(missed), (el) => el.child(div().text_size(12).text_color(t.blocked).child(`Missed: ${fmt(missed)} (the app was closed)`)))
        .when(Boolean(live), (el) => el.child(h_flex().gap(6).items_center()
          .child(div().w(7).h(7).rounded(4).bg(stColor))
          .child(div().text_size(12).text_color(stColor).child(`Last run: ${stText}`))
          .child(button(`open-${j.id}`, "Open tab", false, () => live.open()))))
        .child(div().text_size(11.5).text_color(t.muted).child(`Saved in: This computer · Runs on: ${machineLabel(j.machine)}`))
        .child(div().text_size(11.5).text_color(t.dim).truncate().child(`${j.agent} · ${j.folder || "~"}`))
        .child(div().text_size(12).text_color(t.foreground).truncate().child(j.task))
        .child(h_flex().pt(6).gap(6)
          .child(button(`run-${j.id}`, "Run now", true, (_e, cx) => { fireJob(j, null); cx.notify(); }))
          .when(!j.done, (el) => el.child(button(`tog-${j.id}`, busy ? "Working…" : j.enabled ? "Turn off" : "Turn on", false,
            (_e, cx) => { if (!busy) this.change(cx, j, j.enabled ? "disable" : "enable"); })))
          .when(Boolean(missed), (el) => el.child(button(`skip-${j.id}`, "Skip missed run", false, (_e, cx) => { patchJob(j.id, { lastSlot: missed }); cx.notify(); })))
          .child(button(`del-${j.id}`, "Delete", false, (_e, cx) => { if (!busy) this.change(cx, j, "delete"); })));
    };

    const remoteSections = machines().filter(m=>m.name && (this.selected === "*" || this.selected === m.name)).map(m=>{
      const catalog=this.catalogs[m.name];
      const remoteJobs=catalog?.jobs ?? [];
      return v_flex().id(`catalog-${m.name}`).gap(8)
        .child(div().text_size(13).font_semibold().child(`Saved in: ${m.name}${catalog?.host ? ` · ${catalog.host}` : ""}`))
        .when(!catalog || catalog.loading, el=>el.child(div().text_size(12).text_color(t.dim).child("Reading the remote app's saved list…")))
        .when(Boolean(catalog?.error), el=>el.child(div().text_size(12).text_color(t.blocked).child(`Read failed: ${catalog?.error}${catalog?.stale ? " · showing the list from the last read" : " · job count unknown"}`)))
        .when(Boolean(catalog && !catalog.error && !catalog.loading && remoteJobs.length === 0),el=>el.child(div().text_size(12).text_color(t.dim).child("No jobs saved in this app.")))
        .children(remoteJobs.map(j=>v_flex().p(12).gap(4).rounded(10).border_1().border_color(t.border).bg(t.surface)
          .child(h_flex().gap(6).child(div().flex_1().text_size(13.5).font_semibold().child(j.name)).child(badge(j.enabled ? "On" : "Off",j.enabled)).child(badge("Remote",false)))
          .child(div().text_size(12).text_color(t.muted).child(`Saved in: ${m.name} · Runs on: ${j.machine || m.name} · ${modeOf(j) === "machine" ? "Machine" : "App"}`))
          .child(div().text_size(12).text_color(t.muted).child(`${isOnce(j) ? j.date : j.days?.length === 7 ? "Daily" : (j.days || []).map(d=>DAYS[d]).join("")} ${j.time} · next ${j.nextRunText}`))
          .child(div().text_size(11.5).text_color(t.dim).truncate().child(`${j.agent} · ${j.folder}`))
          .child(div().text_size(12).text_color(t.foreground).truncate().child(j.task))))
        .when(Boolean(catalog?.savedAt),el=>el.child(div().text_size(11.5).text_color(t.dim).child(`Remote list saved ${fmt(catalog?.savedAt)} · read-only, refreshed every minute`)));
    });

    const cronBox = v_flex().p(12).gap(4).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(12.5).font_semibold().child(`${machineLabel(this.selected || null)}'s crontab (read-only)`))
        .child(button("cron-refresh", "Refresh", false, (_e, cx) => this.refreshCron(cx, this.selected))))
      .child(div().text_size(11.5).text_color(t.dim).child(
        cron.loading ? "Loading…" : cron.error ? `Could not read: ${cron.error}` : cron.empty ? "No cron jobs" : ""))
      .children((cron.lines ?? []).map((l, i) => div().id(`cron-${i}`).text_size(11.5).font_family("monospace").text_color(t.foreground).truncate().child(l)));

    const runList = v_flex().gap(2).children(
      runs.slice(0, 8).map((r, i) =>
        div().id(`r-${i}`).text_size(11.5).text_color(t.muted).truncate()
          .child(`${fmt(r.at)} · ${machineLabel(r.machine)} · ${r.name}${r.manual ? " (manual)" : ""}`)),
    );

    return v_flex().id("job-scheduler").size_full().bg(t.background).text_color(t.foreground).p(16).gap(12).overflow_y_scrollbar()
      .child(h_flex().items_center()
        .child(v_flex().flex_1()
          .child(div().text_size(16).font_semibold().child("Scheduled jobs"))
          .child(div().text_size(11.5).text_color(t.dim).child("Jobs listed by the app they are saved in. Each job shows the machine it runs on; reading a remote list never runs or copies its jobs.")))
        .child(button("catalog-refresh", "Refresh lists", false, (_e,cx)=>{this.refreshCatalogs(cx,true);this.refreshCron(cx,this.selected);cx.notify();}))
        .child(button("add-job", this.formOpen ? "Close" : "+ Add job", !this.formOpen, (_e, cx) => { this.formMachine=this.selected === "*" ? "" : this.selected; this.formOpen = !this.formOpen; this.error = ""; cx.notify(); })))
      .child(machineTabs)
      .when(Boolean(this.error) && !this.formOpen, (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .when(this.formOpen, (el) => el.child(form))
      .when(this.selected === "" && mine.length === 0 && !this.formOpen, (el) =>
        el.child(div().py(18).text_size(12.5).text_color(t.dim).child(`No jobs on ${machineLabel(this.selected || null)}.`)))
      .when(mine.length > 0, el=>el.child(div().text_size(13).font_semibold().child("Saved in: This computer")))
      .children(mine.map(jobCard))
      .children(remoteSections)
      .when(this.selected !== "*", el=>el.child(cronBox))
      .when(runs.length > 0, (el) => el.child(div().pt(4).text_size(12.5).font_semibold().child("Recent runs (app mode)")).child(runList));
  }
}
