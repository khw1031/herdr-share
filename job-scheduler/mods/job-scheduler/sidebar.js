// Bottom of the left sidebar (inside the divider): "Scheduled jobs" + Settings + Add machine.
// In a layout it takes the default footer's (workspace-chrome) place, with props: { view: "sidebar" }.
// Settings / Add machine keep the default footer's actions (app.settings, machine-add) and its update dot.
// The narrow mode (icons only) works like the default footer too: labels hidden, tooltips, marks as a dot on the icon.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, updates, layout } from "herdr";
import { loadJobs, missedSlot, liveFor, openDetail } from "./core.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same rule as workspace-chrome: narrow mode when the sidebar is under 160 wide.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

export function renderSidebar() {
  const t = theme();
  const collapsed = narrow();
  const now = Date.now();
  const jobs = loadJobs();
  const attention = jobs.filter((j) => missedSlot(j, now) || liveFor(j)?.status === "blocked").length;
  const row = (id, icon, label, dim, action, tip = label) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
    .when(collapsed, (el) => el.relative().w(32).px(0).justify_center().tooltip(tip))
    .text_color(dim ? t.dim : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
    .on_click(action).child(svg(`mods/job-scheduler/${icon}.svg`).size(14))
    .when(!collapsed, (el) => el.child(div().flex_1().child(label)));
  const dot = (color) => div().size(6).rounded_full().bg(color);
  const ready = Boolean(updates()?.app?.ready);
  const jobsTip = ["Scheduled jobs", jobs.length > 0 && `${jobs.length} total`, attention > 0 && `needs you: ${attention}`].filter(Boolean).join(" · ");

  return v_flex().id("jobs-sidebar").size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
    .when(collapsed, (el) => el.px(0).items_center())
    .child(row("jobs-open", "clock", "Scheduled jobs", false, () => openDetail({}), jobsTip)
      .when(collapsed && attention > 0, (el) => el.child(dot(t.blocked).absolute().top(5).right(6)))
      .when(!collapsed && attention > 0, (el) => el.child(div().px(5).rounded(4).bg(t.blocked).text_size(10.5).text_color(t.background).child(String(attention))))
      .when(!collapsed && jobs.length > 0, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(String(jobs.length)))))
    .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
      .when(ready, (el) => el.child(collapsed ? dot(t.accent).absolute().top(5).right(6) : dot(t.accent))))
    .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
}
