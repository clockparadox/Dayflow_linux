(() => {
  "use strict";

  const STORAGE_KEY = "dayflow-linux-state-v1";
  // Keep one hour spacious enough for detailed activity cards and parallel work.
  const HOUR_HEIGHT = 360;
  const START_HOUR = 4;
  const TOTAL_HOURS = 24;
  const MAX_ANALYSIS_IMAGES = 15;
  // Short activities need roughly this much timeline room for a readable title and time.
  const MIN_VISUAL_CARD_MINUTES = 26;
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const CATEGORY_COLORS = {
    Focus: "#93bcff",
    Communication: "#6cdacd",
    Planning: "#de9dfc",
    Break: "#ffa189",
    Learning: "#ffbe70",
  };

  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  const isDesktopApp = typeof tauriInvoke === "function";
  const DEFAULT_AI = {
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    model: "qwen2.5vl:7b",
    apiKey: "",
    intervalSeconds: 60,
    analysisIntervalMinutes: 15,
  };

  const dateKey = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const parseDate = (value) => {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day, 12);
  };

  const startOfWeek = (date) => {
    const result = new Date(date);
    result.setHours(12, 0, 0, 0);
    const day = result.getDay();
    const offset = day === 0 ? -6 : 1 - day;
    result.setDate(result.getDate() + offset);
    return result;
  };

  const addDays = (date, amount) => {
    const result = new Date(date);
    result.setDate(result.getDate() + amount);
    return result;
  };

  const toMinutes = (time) => {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  };

  const durationMinutes = (activity) => Math.max(0, toMinutes(activity.end) - toMinutes(activity.start));

  const formatTime = (time) => {
    const [hours, minutes] = time.split(":").map(Number);
    const suffix = hours >= 12 ? "PM" : "AM";
    const displayHour = hours % 12 || 12;
    return `${displayHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
  };

  const formatDate = (date, options) => new Intl.DateTimeFormat("en-US", options).format(date);

  const formatDuration = (minutes) => {
    const rounded = Math.max(0, Math.round(minutes));
    const hours = Math.floor(rounded / 60);
    const remainder = rounded % 60;
    if (hours && remainder) return `${hours}h ${remainder}m`;
    if (hours) return `${hours}h`;
    return `${remainder}m`;
  };

  const uid = () => `activity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const getSeedActivities = () => {
    const monday = startOfWeek(new Date());
    const templates = [
      [0, "09:10", "10:35", "Refined the current product direction", "Focus", "Worked through the open design questions and turned them into a short, usable plan."],
      [0, "11:10", "12:00", "Project sync with the team", "Communication", "Shared progress, surfaced a blocker, and aligned on the next small step."],
      [0, "14:00", "15:25", "Built the first working draft", "Focus", "Kept the scope narrow and made the important path feel tangible."],
      [1, "09:30", "10:50", "Research and reference gathering", "Learning", "Collected a few useful patterns and wrote down what to borrow and what to avoid."],
      [1, "13:20", "14:40", "Implemented the new interaction", "Focus", "A quiet block of making progress without switching contexts."],
      [2, "10:00", "11:15", "Weekly planning", "Planning", "Set the shape of the week and chose the one outcome that matters most."],
      [2, "13:30", "15:10", "Deep work on the main task", "Focus", "Moved the central piece forward and left a clean note for tomorrow."],
      [3, "09:15", "10:05", "Review and feedback", "Communication", "Looked at the latest version with fresh eyes and captured the changes."],
      [3, "11:00", "12:40", "Polished the prototype", "Focus", "Removed friction from the small details that make the whole thing feel finished."],
      [4, "09:45", "11:30", "Finished the weekly milestone", "Focus", "Closed the loop on the work that had been carrying across the week."],
      [4, "14:10", "14:40", "Walk and reset", "Break", "A short break away from the screen."],
    ];
    return templates.map(([dayOffset, start, end, title, category, summary]) => ({
      id: uid(),
      date: dateKey(addDays(monday, dayOffset)),
      start,
      end,
      title,
      category,
      summary,
    }));
  };

  const loadState = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (stored && Array.isArray(stored.activities)) {
        return {
          activities: stored.activities,
          screenshots: Array.isArray(stored.screenshots) ? stored.screenshots : [],
          ai: stored.ai && typeof stored.ai === "object" ? stored.ai : { ...DEFAULT_AI },
          notes: stored.notes && typeof stored.notes === "object" ? stored.notes : {},
        };
      }
    } catch (_error) {
      // A malformed local record should never prevent the app from opening.
    }
    return { activities: isDesktopApp ? [] : getSeedActivities(), screenshots: [], ai: { ...DEFAULT_AI }, notes: {} };
  };

  const initialData = loadState();
  const state = {
    ...initialData,
    ai: { ...DEFAULT_AI, ...(initialData.ai || {}) },
    screenshots: initialData.screenshots || [],
    view: "timeline",
    timelineMode: "day",
    selectedDate: new Date(),
    selectedWeekStart: startOfWeek(new Date()),
    selectedActivityId: null,
    captureMonitorId: null,
    captureTimer: null,
    analysisTimer: null,
    lockPollTimer: null,
    isCapturing: false,
    isCaptureBusy: false,
    isAnalysisBusy: false,
    pendingScreenshotIds: [],
    isSystemLocked: false,
    lockSources: new Set(),
    lockStartedAt: null,
    captureWasActiveBeforeLock: false,
    lastError: "",
  };

  const saveState = () => {
    const data = {
      activities: state.activities,
      screenshots: state.screenshots,
      notes: state.notes,
      ai: state.ai,
    };
    if (isDesktopApp) {
      return tauriInvoke("save_dayflow_data", { data }).catch((error) => {
        reportError("Could not save local data", error);
      });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return Promise.resolve();
  };

  const loadDesktopData = async () => {
    if (!isDesktopApp) return;
    try {
      const data = await tauriInvoke("load_dayflow_data");
      state.activities = Array.isArray(data?.activities) ? collapseAiActivities(data.activities) : [];
      state.screenshots = Array.isArray(data?.screenshots) ? data.screenshots : [];
      state.notes = data?.notes && typeof data.notes === "object" ? data.notes : {};
      state.ai = { ...DEFAULT_AI, ...(data?.ai || {}) };
      state.pendingScreenshotIds = state.screenshots
        .filter((screenshot) => !screenshot.analyzed)
        .map((screenshot) => screenshot.id);
      updateAiSourceLabel();
      renderTimelineView();
      renderWeeklyView();
      setCaptureState(state.screenshots.length ? "Ready to continue capture" : "Ready for screen capture");
    } catch (error) {
      reportError("Could not load local data", error);
    }
  };

  const activitiesForDate = (date) => state.activities
    .filter((activity) => activity.date === dateKey(date))
    .sort((a, b) => a.start.localeCompare(b.start));

  const timeFromMinutes = (total) => {
    const clamped = Math.min(23 * 60 + 59, Math.max(0, total));
    return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
  };

  const collapseAiActivities = (activities) => {
    const groups = new Map();
    const manual = [];
    activities.forEach((activity) => {
      const sourceIds = Array.isArray(activity.sourceScreenshotIds) ? [...new Set(activity.sourceScreenshotIds)].sort() : [];
      if (!sourceIds.length) {
        manual.push(activity);
        return;
      }
      const key = sourceIds.join("|");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...activity, sourceScreenshotIds: sourceIds });
    });

    const merged = [...manual];
    groups.forEach((items) => {
      items.sort((left, right) => `${left.date}${left.start}`.localeCompare(`${right.date}${right.start}`));
      if (items.length === 1) {
        merged.push(items[0]);
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const startMinutes = toMinutes(first.start);
      const lastEnd = Math.max(...items.map((item) => toMinutes(item.end)));
      const end = first.date === last.date && lastEnd - startMinutes < 15
        ? timeFromMinutes(startMinutes + 15)
        : timeFromMinutes(lastEnd);
      const categories = new Set(items.map((item) => item.category));
      const summary = items
        .map((item) => `${item.title} (${formatTime(item.start)}–${formatTime(item.end)}): ${item.summary || "No additional note."}`)
        .join("\n");
      merged.push({
        ...first,
        title: `${first.title} + ${items.length - 1} more`,
        end,
        category: categories.size === 1 ? first.category : "Focus",
        summary,
        detailedSummary: summary,
        sourceScreenshotIds: [...new Set(items.flatMap((item) => item.sourceScreenshotIds))],
      });
    });
    return merged.sort((left, right) => `${left.date}${left.start}`.localeCompare(`${right.date}${right.start}`));
  };

  const activitiesForWeek = (weekStart) => {
    const keys = new Set(Array.from({ length: 7 }, (_, index) => dateKey(addDays(weekStart, index))));
    return state.activities.filter((activity) => keys.has(activity.date));
  };

  const colorFor = (category) => CATEGORY_COLORS[category] || CATEGORY_COLORS.Focus;

  const styleForCategory = (category, alpha = 0.18) => {
    const hex = colorFor(category).replace("#", "");
    const number = Number.parseInt(hex, 16);
    const red = (number >> 16) & 255;
    const green = (number >> 8) & 255;
    const blue = number & 255;
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  };

  const renderTimeRows = (includeLabel = true) => {
    const now = new Date();
    return Array.from({ length: TOTAL_HOURS }, (_, index) => {
      const hour = (START_HOUR + index) % 24;
      const isCurrent = hour === now.getHours();
      const label = `${hour % 12 || 12}:00 ${hour >= 12 ? "PM" : "AM"}`;
      return `<div class="time-row"><span class="time-label${isCurrent ? " is-current" : ""}">${includeLabel ? label : ""}</span></div>`;
    }).join("");
  };

  const layoutOverlappingActivities = (activities) => {
    const sorted = activities.slice().sort((left, right) => left.start.localeCompare(right.start));
    const layouts = new Map();
    let group = [];
    let groupEnd = -1;

    const visualEnd = (activity) => Math.max(
      toMinutes(activity.end),
      toMinutes(activity.start) + MIN_VISUAL_CARD_MINUTES,
    );

    const assignGroupLanes = (items) => {
      if (!items.length) return;
      const laneEnds = [];
      items.forEach((activity) => {
        const start = toMinutes(activity.start);
        const end = visualEnd(activity);
        let lane = laneEnds.findIndex((lastEnd) => lastEnd <= start);
        if (lane === -1) {
          lane = laneEnds.length;
          laneEnds.push(end);
        } else {
          laneEnds[lane] = end;
        }
        layouts.set(activity.id, { lane, laneCount: 0 });
      });
      items.forEach((activity) => {
        layouts.get(activity.id).laneCount = laneEnds.length;
      });
    };

    sorted.forEach((activity) => {
      const start = toMinutes(activity.start);
      const end = visualEnd(activity);
      if (group.length && start >= groupEnd) {
        assignGroupLanes(group);
        group = [];
      }
      group.push(activity);
      groupEnd = Math.max(groupEnd, end);
    });
    assignGroupLanes(group);

    return sorted.map((activity) => ({
      activity,
      ...layouts.get(activity.id),
    }));
  };

  const cardMarkup = (activity, options = {}) => {
    const minutesFromStart = toMinutes(activity.start) - START_HOUR * 60;
    const top = clamp(minutesFromStart, 0, TOTAL_HOURS * 60) * (HOUR_HEIGHT / 60);
    const height = Math.max(28, durationMinutes(activity) * (HOUR_HEIGHT / 60) - 3);
    const selected = state.selectedActivityId === activity.id ? " is-selected" : "";
    const compact = height < 49 ? " compact" : "";
    const color = colorFor(activity.category);
    const fill = styleForCategory(activity.category, options.week ? 0.24 : 0.2);
    const laneCount = options.laneCount || 1;
    const laneWidth = 100 / laneCount;
    const laneStyle = `left: calc(${(options.lane || 0) * laneWidth}% + 3px); width: calc(${laneWidth}% - 6px); right: auto;`;
    const positionStyle = `top: ${top}px; height: ${height}px; ${laneStyle}`;
    return `<button class="activity-card${selected}${compact}" data-activity-id="${activity.id}" title="${escapeHtml(activity.title)}" style="${positionStyle} --card-color: ${color}; --card-fill: ${fill}; --card-border: ${styleForCategory(activity.category, 0.5)}" type="button">
      <span class="activity-title">${escapeHtml(activity.title)}</span>
      <span class="activity-time">${formatTime(activity.start)} – ${formatTime(activity.end)}</span>
      <span class="activity-summary">${escapeHtml(activity.summary || activity.category)}</span>
    </button>`;
  };

  const renderTimeline = () => {
    const container = $("#timeline-content");
    if (state.timelineMode === "day") {
      const activities = activitiesForDate(state.selectedDate);
      const laidOutActivities = layoutOverlappingActivities(activities);
      container.innerHTML = `<div class="day-timeline">
        <div class="time-lines">${renderTimeRows()}</div>
        <div class="day-cards">${activities.length ? laidOutActivities.map(({ activity, lane, laneCount }) => cardMarkup(activity, { lane, laneCount })).join("") : renderEmptyTimeline()}</div>
      </div>`;
    } else {
      const weekStart = startOfWeek(state.selectedDate);
      state.selectedWeekStart = weekStart;
      const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
      container.innerHTML = `<div class="week-timeline">
        <div class="week-day-headings">${days.map((date) => `<div class="week-day-heading${dateKey(date) === dateKey(new Date()) ? " is-today" : ""}"><span>${formatDate(date, { weekday: "short" })}</span><span class="day-number">${date.getDate()}</span></div>`).join("")}</div>
        <div class="week-timeline-body">
          <div class="time-lines">${renderTimeRows()}</div>
          <div class="week-day-columns">${days.map((date) => `<div class="week-day-column">${layoutOverlappingActivities(activitiesForDate(date)).map(({ activity, lane, laneCount }) => cardMarkup(activity, { week: true, lane, laneCount })).join("")}</div>`).join("")}</div>
        </div>
      </div>`;
    }
    $$("[data-activity-id]", container).forEach((button) => {
      button.addEventListener("click", () => selectActivity(button.dataset.activityId));
    });
  };

  const renderEmptyTimeline = () => `<div class="timeline-empty">
    <div class="timeline-empty-mark">＋</div>
    <strong>No activity recorded yet</strong>
    <span>Use “Add activity” to make the first card for this day.</span>
  </div>`;

  const renderTimelineSummary = () => {
    const activities = state.timelineMode === "day"
      ? activitiesForDate(state.selectedDate)
      : activitiesForWeek(startOfWeek(state.selectedDate));
    const total = activities.reduce((sum, activity) => sum + durationMinutes(activity), 0);
    const focus = activities
      .filter((activity) => activity.category === "Focus")
      .reduce((sum, activity) => sum + durationMinutes(activity), 0);
    $("#timeline-summary").innerHTML = [
      [formatDuration(total), state.timelineMode === "day" ? "tracked today" : "tracked this week"],
      [String(activities.length), "activity cards"],
      [formatDuration(focus), "focused work"],
    ].map(([value, label]) => `<div class="summary-chip"><strong>${value}</strong><span>${label}</span></div>`).join("");
  };

  const renderDateLabels = () => {
    const today = new Date();
    const selected = state.selectedDate;
    const sameDay = dateKey(today) === dateKey(selected);
    $("#timeline-date").textContent = sameDay
      ? `Today, ${formatDate(selected, { month: "short", day: "numeric" })}`
      : formatDate(selected, { weekday: "short", month: "short", day: "numeric" });
    $("#timeline-date-input").value = dateKey(selected);
    $("#timeline-heading").textContent = state.timelineMode === "day"
      ? (sameDay ? "A clear view of your day" : `Your ${formatDate(selected, { weekday: "long" })}`)
      : "The shape of your week";
  };

  const renderTimelineView = () => {
    renderDateLabels();
    renderTimelineSummary();
    renderTimeline();
    renderDetail();
  };

  const selectActivity = (id) => {
    state.selectedActivityId = id;
    renderTimeline();
    renderDetail();
  };

  const renderDetail = () => {
    const activity = state.activities.find((item) => item.id === state.selectedActivityId);
    const detail = $("#activity-detail");
    if (!activity) {
      detail.innerHTML = `<div class="detail-empty">
        <div class="detail-empty-orb" aria-hidden="true">✦</div>
        <h2>Choose a moment</h2>
        <p>Select an activity to see its notes and time range.</p>
      </div>`;
      return;
    }
    const sourceCount = Array.isArray(activity.sourceScreenshotIds) ? activity.sourceScreenshotIds.length : 0;
    const sourceNote = sourceCount ? `AI estimated from ${sourceCount} screen snapshots.` : "Added manually to the timeline.";
    detail.innerHTML = `<div class="detail-content">
      <div class="detail-topline">
        <div><p class="section-kicker">ACTIVITY NOTE</p><h2>${escapeHtml(activity.title)}</h2></div>
        <button class="dialog-close" id="close-detail" type="button" aria-label="Close activity details">×</button>
      </div>
      <div class="detail-category" style="--card-color: ${colorFor(activity.category)}">${escapeHtml(activity.category)}</div>
      <div class="detail-time">${formatDate(parseDate(activity.date), { weekday: "long", month: "long", day: "numeric" })}<br>${formatTime(activity.start)} – ${formatTime(activity.end)} · ${formatDuration(durationMinutes(activity))}</div>
      <p class="detail-label">SUMMARY</p>
      <p class="detail-summary">${escapeHtml(activity.summary || "No note was added for this activity.")}</p>
      <div class="detail-actions"><button class="detail-delete" id="delete-activity" type="button">Delete card</button><span class="detail-edit-hint">${sourceNote} Timeline cards are stored locally.</span></div>
    </div>`;
    $("#close-detail").addEventListener("click", () => selectActivity(null));
    $("#delete-activity").addEventListener("click", () => deleteActivity(activity.id));
  };

  const deleteActivity = (id) => {
    const activity = state.activities.find((item) => item.id === id);
    if (!activity || !window.confirm(`Delete “${activity.title}”?`)) return;
    state.activities = state.activities.filter((item) => item.id !== id);
    state.selectedActivityId = null;
    saveState();
    renderTimelineView();
    renderWeeklyView();
  };

  const renderWeeklyView = () => {
    const weekStart = state.selectedWeekStart;
    const weekEnd = addDays(weekStart, 6);
    const activities = activitiesForWeek(weekStart);
    const byDay = Array.from({ length: 7 }, (_, index) => activities.filter((activity) => activity.date === dateKey(addDays(weekStart, index))));
    const totalMinutes = activities.reduce((sum, activity) => sum + durationMinutes(activity), 0);
    const focusMinutes = activities.filter((activity) => activity.category === "Focus").reduce((sum, activity) => sum + durationMinutes(activity), 0);
    const focusRatio = totalMinutes ? Math.round((focusMinutes / totalMinutes) * 100) : 0;
    const transitions = activities.slice().sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`)).reduce((count, activity, index, all) => count + (index && all[index - 1].category !== activity.category ? 1 : 0), 0);

    $("#week-title").textContent = `${formatDate(weekStart, { month: "short", day: "numeric" })} – ${formatDate(weekEnd, { month: "short", day: "numeric", year: "numeric" })}`;
    $("#review-focus-time").textContent = formatDuration(focusMinutes);
    $("#review-focus-caption").textContent = focusMinutes ? `${focusRatio}% of your recorded time` : "Start recording to build your week.";
    $("#review-title").textContent = totalMinutes >= 600 ? "You made room for meaningful work." : totalMinutes ? "A week worth of momentum." : "Your week is still unwritten.";
    $("#review-subtitle").textContent = totalMinutes
      ? `${activities.length} moments captured across ${byDay.filter((day) => day.length).length} days. Here is the pattern, without the noise.`
      : "Record a few moments in Timeline and your weekly picture will take shape here.";

    renderDistribution(byDay, totalMinutes);
    renderPulse(byDay, focusMinutes, transitions);
    renderCategories(activities);
    const notes = state.notes[dateKey(weekStart)] || "";
    if (document.activeElement !== $("#weekly-notes")) $("#weekly-notes").value = notes;
  };

  const renderDistribution = (byDay, totalMinutes) => {
    const maxDayMinutes = Math.max(1, ...byDay.map((day) => day.reduce((sum, activity) => sum + durationMinutes(activity), 0)));
    $("#distribution-chart").innerHTML = byDay.map((day, index) => {
      const dayTotal = day.reduce((sum, activity) => sum + durationMinutes(activity), 0);
      const segments = day.map((activity) => `<span class="distribution-segment" title="${escapeHtml(activity.title)}" style="flex: ${durationMinutes(activity)} 1 0; background: ${colorFor(activity.category)}"></span>`).join("");
      const scale = totalMinutes ? (dayTotal / maxDayMinutes) * 100 : 0;
      return `<div class="distribution-row"><span class="distribution-day">${DAY_NAMES[(index + 1) % 7]}</span><div class="distribution-track" style="width: ${Math.max(5, scale)}%">${segments || `<span class="distribution-segment" style="flex: 1; background: rgba(191, 182, 174, .55)"></span>`}</div><span class="distribution-total">${dayTotal ? formatDuration(dayTotal) : "–"}</span></div>`;
    }).join("");
    const categories = Object.keys(CATEGORY_COLORS).filter((category) => byDay.flat().some((activity) => activity.category === category));
    $("#chart-legend").innerHTML = (categories.length ? categories : ["Focus", "Communication", "Planning"]).map((category) => `<span class="legend-item"><i class="legend-swatch" style="background: ${colorFor(category)}"></i>${category}</span>`).join("");
  };

  const renderPulse = (byDay, focusMinutes, transitions) => {
    const values = byDay.map((day) => day.reduce((sum, activity) => sum + durationMinutes(activity), 0));
    const max = Math.max(1, ...values);
    const points = values.map((value, index) => {
      const x = (index / 6) * 620;
      const y = 145 - (value / max) * 106;
      return { x, y, value };
    });
    const line = points.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
    $("#pulse-line").setAttribute("d", line || "M 0 145 L 620 145");
    $("#pulse-area").setAttribute("d", `${line || "M 0 145 L 620 145"} L 620 155 L 0 155 Z`);
    $("#pulse-nodes").innerHTML = points.map((point) => `<circle class="pulse-node" cx="${point.x}" cy="${point.y}" r="4"></circle>`).join("");
    const activeDays = values.filter(Boolean).length;
    $("#pulse-stats").innerHTML = `<div class="pulse-stat"><span>RECORDED DAYS</span><strong>${activeDays} / 7</strong></div><div class="pulse-stat"><span>CONTEXT SHIFTS</span><strong>${transitions}</strong></div>`;
  };

  const renderCategories = (activities) => {
    const totals = Object.entries(CATEGORY_COLORS).map(([category]) => [category, activities.filter((activity) => activity.category === category).reduce((sum, activity) => sum + durationMinutes(activity), 0)]).filter(([, minutes]) => minutes > 0).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...totals.map(([, minutes]) => minutes));
    $("#category-list").innerHTML = totals.length ? totals.map(([category, minutes]) => `<div class="category-row"><span class="category-name">${category}</span><div class="category-track"><div class="category-fill" style="width: ${(minutes / max) * 100}%; background: ${colorFor(category)}"></div></div><span class="category-value">${formatDuration(minutes)}</span></div>`).join("") : `<p class="detail-edit-hint">No categories yet. Timeline activity will appear here.</p>`;
  };

  const setView = (view) => {
    state.view = view;
    $$(`[data-view-target]`).forEach((button) => button.classList.toggle("is-active", button.dataset.viewTarget === view));
    $$(`[data-view]`).forEach((panel) => {
      const visible = panel.dataset.view === view;
      panel.hidden = !visible;
      panel.classList.toggle("is-visible", visible);
    });
    $("#page-title").textContent = view === "timeline" ? "Timeline" : "Weekly review";
    $("#page-eyebrow").textContent = view === "timeline" ? "PERSONAL ACTIVITY" : "A QUIET LOOK BACK";
    if (view === "weekly") renderWeeklyView();
  };

  const moveTimelineDate = (amount) => {
    state.selectedDate = addDays(state.selectedDate, amount);
    state.selectedActivityId = null;
    renderTimelineView();
  };

  const moveWeek = (amount) => {
    state.selectedWeekStart = addDays(state.selectedWeekStart, amount * 7);
    state.selectedDate = state.selectedWeekStart;
    renderWeeklyView();
  };

  const openActivityDialog = () => {
    const dialog = $("#activity-dialog");
    $("#activity-date").value = dateKey(state.selectedDate);
    const now = new Date();
    const roundedMinutes = Math.floor(now.getMinutes() / 5) * 5;
    const startHour = String(now.getHours()).padStart(2, "0");
    const startMinute = String(roundedMinutes).padStart(2, "0");
    $("#activity-start").value = `${startHour}:${startMinute}`;
    $("#activity-end").value = `${startHour}:${String(Math.min(55, roundedMinutes + 30)).padStart(2, "0")}`;
    $("#activity-title").value = "";
    $("#activity-summary").value = "";
    $("#form-error").textContent = "";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    setTimeout(() => $("#activity-title").focus(), 0);
  };

  const errorText = (error) => {
    if (typeof error === "string") return error;
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    if (error && typeof error === "object") {
      if (typeof error.message === "string") return error.message;
      if (typeof error.error === "string") return error.error;
      if (typeof error.reason === "string") return error.reason;
      try {
        return JSON.stringify(error, null, 2);
      } catch (_serializationError) {
        return String(error);
      }
    }
    return String(error);
  };

  const reportError = (context, error) => {
    const rawError = errorText(error);
    const unsupportedImageInput = /does not support image input|image input.*support|cannot read.*image/i.test(rawError);
    const modelHint = unsupportedImageInput
      ? "\n\nAction required\nThe selected model cannot accept images. Open AI source and choose a vision-capable model, for example qwen2.5vl:7b in Ollama."
      : "";
    const detail = `${context}\n\n${rawError}${modelHint}\n\nEnvironment\n- Runtime: ${window.__TAURI__ ? "Tauri desktop" : "Browser preview"}\n- Capture backend: grim on Wayland, xcap/X11 otherwise`;
    state.lastError = detail;
    setCaptureState(
      unsupportedImageInput ? "Selected model cannot read images · click for details" : `${context} · click for details`,
      true,
    );
    if (isDesktopApp) {
      tauriInvoke("append_dayflow_log", { message: detail }).catch(() => {});
    }
  };

  const openErrorDialog = () => {
    if (!state.lastError) return;
    $("#error-detail").textContent = state.lastError;
    const dialog = $("#error-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  };

  const setCaptureState = (message, busy = false) => {
    const element = $("#capture-state");
    const footnote = $("#capture-footnote");
    if (!element || !footnote) return;
    if (!busy) state.lastError = "";
    element.textContent = message;
    element.classList.toggle("is-busy", busy);
    element.classList.toggle("is-active", state.isCapturing && !busy);
    footnote.textContent = state.isSystemLocked
      ? "Screen capture is paused while the desktop is locked. Pending pre-lock snapshots are kept; lock-screen frames are discarded."
      : state.isAnalysisBusy
      ? "Dayflow is analyzing the latest screen batch. New snapshots stay on this device until the analysis finishes."
      : state.isCapturing
        ? `Capturing this monitor every ${state.ai.intervalSeconds} seconds. After a few snapshots, AI will add concrete work cards with estimated durations.`
      : (isDesktopApp
        ? "Screen capture is off. Use Record screen to let AI turn screen snapshots into concrete timeline cards."
        : "Browser preview mode: manual cards work here, while screen capture requires the Tauri desktop app.");
  };

  const updateAiSourceLabel = () => {
    const label = $("#ai-source-label");
    const dot = $(".ai-source-dot");
    if (!label || !dot) return;
    label.textContent = state.ai.provider === "ollama" ? state.ai.model || "Ollama" : state.ai.model || "OpenAI-compatible";
    dot.classList.toggle("is-remote", state.ai.provider !== "ollama");
  };

  const openAiDialog = () => {
    $("#ai-provider").value = state.ai.provider;
    $("#ai-endpoint").value = state.ai.endpoint;
    $("#ai-model").value = state.ai.model;
    $("#ai-api-key").value = state.ai.apiKey || "";
    $("#capture-interval").value = String(state.ai.intervalSeconds);
    $("#analysis-interval").value = String(state.ai.analysisIntervalMinutes || DEFAULT_AI.analysisIntervalMinutes);
    $("#ai-form-error").textContent = "";
    updateAiProviderFields();
    const dialog = $("#ai-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  };

  const updateAiProviderFields = () => {
    const local = $("#ai-provider").value === "ollama";
    $("#ai-api-key-row").classList.toggle("is-hidden", local);
    $("#ai-endpoint").placeholder = local ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234/v1";
    $("#ai-model").placeholder = local ? "qwen2.5vl:7b" : "local vision model";
  };

  const readAiSettingsForm = () => ({
    provider: $("#ai-provider").value,
    endpoint: $("#ai-endpoint").value.trim().replace(/\/$/, ""),
    model: $("#ai-model").value.trim(),
    apiKey: $("#ai-api-key").value.trim(),
    intervalSeconds: Number($("#capture-interval").value) || DEFAULT_AI.intervalSeconds,
    analysisIntervalMinutes: Number($("#analysis-interval").value) || DEFAULT_AI.analysisIntervalMinutes,
  });

  const testAiConnection = async () => {
    const status = $("#ai-test-status");
    const button = $("#test-ai-connection");
    const settings = readAiSettingsForm();
    if (!isDesktopApp) {
      status.textContent = "Testing requires the Tauri desktop app.";
      status.className = "is-error";
      return;
    }
    if (!settings.endpoint || !settings.model) {
      status.textContent = "Enter an endpoint and vision model first.";
      status.className = "is-error";
      return;
    }

    button.disabled = true;
    status.textContent = "Sending a test image…";
    status.className = "is-testing";
    try {
      const result = await invokeTauri("test_ai_connection", { settings });
      status.textContent = `Connected · ${result.latencyMs} ms · image input accepted`;
      status.className = "is-success";
      status.title = result.message;
      state.lastError = "";
    } catch (error) {
      const rawError = errorText(error);
      const imageHint = /does not support image input|image input.*support|cannot read.*image/i.test(rawError)
        ? "\n\nThis model is text-only. Choose a vision model such as qwen2.5vl:7b."
        : "";
      state.lastError = `AI connection test failed\n\n${rawError}${imageHint}\n\nProvider: ${settings.provider}\nEndpoint: ${settings.endpoint}\nModel: ${settings.model}`;
      status.textContent = "Test failed · click for full error";
      status.className = "is-error";
      status.title = state.lastError;
    } finally {
      button.disabled = false;
    }
  };

  const saveAiSettings = (event) => {
    const submitter = event.submitter;
    if (!submitter || submitter.id !== "save-ai-settings") return;
    event.preventDefault();
    const settings = readAiSettingsForm();
    const endpoint = settings.endpoint;
    const model = settings.model;
    if (!endpoint || !model) {
      $("#ai-form-error").textContent = "Endpoint and vision model are required.";
      return;
    }
    state.ai = settings;
    updateAiSourceLabel();
    saveState();
    const wasCapturing = state.isCapturing;
    if (wasCapturing) {
      stopCaptureSession({ analyze: false });
      startCaptureSession();
    }
    $("#ai-dialog").close();
    setCaptureState(state.isCapturing ? "Capture settings updated" : "Ready for screen capture");
  };

  const invokeTauri = (command, payload) => {
    if (!isDesktopApp) return Promise.reject(new Error("This action requires the Tauri desktop app."));
    return tauriInvoke(command, payload);
  };

  const clearCaptureTimers = () => {
    if (state.captureTimer) window.clearInterval(state.captureTimer);
    if (state.analysisTimer) window.clearInterval(state.analysisTimer);
    state.captureTimer = null;
    state.analysisTimer = null;
  };

  const handleLockState = async (payload) => {
    const source = payload?.source || "desktop";
    const locked = Boolean(payload?.locked);
    if (locked) {
      if (!state.lockSources.size) state.lockStartedAt = Number(payload?.at) || Math.floor(Date.now() / 1000);
      state.lockSources.add(source);
      if (!state.isSystemLocked) {
        state.isSystemLocked = true;
        state.captureWasActiveBeforeLock = state.isCapturing;
        clearCaptureTimers();
        state.isCapturing = false;
        state.captureMonitorId = null;
        setCaptureState("Paused while desktop is locked");
        updateRecordingButton();
      }
      return;
    }

    state.lockSources.delete(source);
    if (state.lockSources.size || !state.isSystemLocked) return;
    state.isSystemLocked = false;
    const lockStartedAt = state.lockStartedAt;
    state.lockStartedAt = null;
    if (lockStartedAt) {
      try {
        await invokeTauri("discard_screenshots_since", { capturedAt: lockStartedAt });
        const data = await invokeTauri("load_dayflow_data");
        state.activities = Array.isArray(data?.activities) ? collapseAiActivities(data.activities) : state.activities;
        state.screenshots = Array.isArray(data?.screenshots) ? data.screenshots : state.screenshots;
        state.pendingScreenshotIds = state.screenshots.filter((screenshot) => !screenshot.analyzed).map((screenshot) => screenshot.id);
      } catch (error) {
        reportError("Could not discard lock-screen frames", error);
      }
    }
    renderTimelineView();
    renderWeeklyView();
    if (state.captureWasActiveBeforeLock) {
      state.captureWasActiveBeforeLock = false;
      await startCaptureSession();
    } else {
      setCaptureState("Unlocked; capture is off");
      updateRecordingButton();
    }
  };

  const installLockStateListener = async () => {
    const listen = window.__TAURI__?.event?.listen;
    if (!isDesktopApp || typeof listen !== "function") return;
    try {
      await listen("dayflow-lock-state", (event) => {
        handleLockState(event.payload);
      });
      const pollLockState = async () => {
        try {
          const locked = await invokeTauri("get_system_lock_state");
          await handleLockState({ locked, source: "polling-logind", at: Math.floor(Date.now() / 1000) });
        } catch (_error) {
          // Signal monitoring remains the primary path; polling is only a fallback.
        }
      };
      await pollLockState();
      state.lockPollTimer = window.setInterval(pollLockState, 5000);
    } catch (error) {
      reportError("Lock-state monitoring unavailable", error);
    }
  };

  const startCaptureSession = async () => {
    if (!isDesktopApp) {
      setCaptureState("Screen capture is available in the Tauri app", true);
      return;
    }
    if (state.isCapturing || state.isSystemLocked) {
      if (state.isSystemLocked) setCaptureState("Capture is paused while desktop is locked", true);
      return;
    }
    try {
      const monitors = await invokeTauri("get_capture_monitors");
      if (!Array.isArray(monitors) || !monitors.length) throw new Error("No capturable monitor was found.");
      if (state.isSystemLocked) {
        setCaptureState("Capture is paused while desktop is locked", true);
        return;
      }
      state.captureMonitorId = monitors[0].id;
      state.isCapturing = true;
      state.pendingScreenshotIds = state.screenshots.filter((screenshot) => !screenshot.analyzed).map((screenshot) => screenshot.id);
      state.captureTimer = window.setInterval(captureScreenshot, state.ai.intervalSeconds * 1000);
      state.analysisTimer = window.setInterval(
        () => analyzePendingScreenshots(),
        state.ai.analysisIntervalMinutes * 60 * 1000
      );
      updateRecordingButton();
      setCaptureState(`Capturing ${monitors[0].name || "this monitor"}`);
      await captureScreenshot();
    } catch (error) {
      state.isCapturing = false;
      if (state.captureTimer) window.clearInterval(state.captureTimer);
      state.captureTimer = null;
      updateRecordingButton();
      reportError("Capture unavailable", error);
    }
  };

  const stopCaptureSession = ({ analyze = true } = {}) => {
    clearCaptureTimers();
    state.isCapturing = false;
    state.captureMonitorId = null;
    updateRecordingButton();
    setCaptureState("Capture stopped");
    if (analyze) analyzePendingScreenshots(true);
  };

  const captureScreenshot = async () => {
    if (!state.isCapturing || state.isSystemLocked || state.isCaptureBusy || state.captureMonitorId === null) return;
    state.isCaptureBusy = true;
    setCaptureState(state.isAnalysisBusy ? "Capturing and analyzing…" : "Capturing screen…", true);
    try {
      const sourcePath = await invokeTauri("capture_monitor_screenshot", { id: state.captureMonitorId });
      if (state.isSystemLocked) return;
      const screenshot = await invokeTauri("store_captured_screenshot", {
        sourcePath,
        capturedAt: Math.floor(Date.now() / 1000),
      });
      if (state.isSystemLocked) {
        await invokeTauri("discard_screenshots_since", { capturedAt: state.lockStartedAt || screenshot.capturedAt });
        return;
      }
      state.screenshots.push(screenshot);
      state.pendingScreenshotIds.push(screenshot.id);
      await saveState();
      setCaptureState(`${state.pendingScreenshotIds.length} snapshot${state.pendingScreenshotIds.length === 1 ? "" : "s"} in the current ${state.ai.analysisIntervalMinutes}-minute batch`);
    } catch (error) {
      clearCaptureTimers();
      state.isCapturing = false;
      state.captureMonitorId = null;
      reportError("Capture failed", error);
    } finally {
      state.isCaptureBusy = false;
      updateRecordingButton();
    }
  };

  const analyzePendingScreenshots = async (force = false) => {
    if (!isDesktopApp || state.isAnalysisBusy) return;
    const pending = [...new Set(state.pendingScreenshotIds)].slice(-MAX_ANALYSIS_IMAGES);
    if (pending.length < 2 && !force) return;
    if (!pending.length) return;
    state.isAnalysisBusy = true;
    setCaptureState("Analyzing screen activity…", true);
    try {
      await invokeTauri("analyze_screenshots", { request: { screenshotIds: pending } });
      const data = await invokeTauri("load_dayflow_data");
      state.activities = Array.isArray(data?.activities) ? collapseAiActivities(data.activities) : state.activities;
      state.screenshots = Array.isArray(data?.screenshots) ? data.screenshots : state.screenshots;
      state.pendingScreenshotIds = state.screenshots.filter((screenshot) => !screenshot.analyzed).map((screenshot) => screenshot.id);
      renderTimelineView();
      renderWeeklyView();
      setCaptureState(`AI added cards from ${pending.length} snapshots`);
    } catch (error) {
      reportError("AI analysis waiting", error);
    } finally {
      state.isAnalysisBusy = false;
      updateRecordingButton();
    }
  };

  const saveActivityFromForm = (event) => {
    const submitter = event.submitter;
    if (!submitter || submitter.id !== "save-activity") return;
    event.preventDefault();
    const date = $("#activity-date").value;
    const start = $("#activity-start").value;
    const end = $("#activity-end").value;
    const title = $("#activity-title").value.trim();
    if (!date || !start || !end || !title) return;
    if (toMinutes(end) <= toMinutes(start)) {
      $("#form-error").textContent = "End time needs to be after the start time.";
      return;
    }
    state.activities.push({
      id: uid(),
      date,
      start,
      end,
      title,
      category: $("#activity-category").value,
      summary: $("#activity-summary").value.trim(),
    });
    state.selectedDate = parseDate(date);
    state.selectedActivityId = null;
    saveState();
    $("#activity-dialog").close();
    renderTimelineView();
    renderWeeklyView();
  };

  const toggleRecording = () => {
    if (state.isCapturing) stopCaptureSession();
    else startCaptureSession();
  };

  const updateRecordingButton = () => {
    const button = $("#record-toggle");
    const label = $("#record-label");
    const duration = $("#record-duration");
    const recording = state.isCapturing;
    button.classList.toggle("is-recording", recording);
    button.disabled = state.isSystemLocked;
    label.textContent = state.isSystemLocked ? "Desktop locked" : (recording ? "Stop capture" : "Record screen");
    duration.textContent = state.isAnalysisBusy ? " · analyzing" : (recording ? ` · ${state.pendingScreenshotIds.length} queued` : "");
  };

  const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));

  const bindEvents = () => {
    $$(`[data-view-target]`).forEach((button) => button.addEventListener("click", () => setView(button.dataset.viewTarget)));
    $$(`[data-timeline-mode]`).forEach((button) => button.addEventListener("click", () => {
      state.timelineMode = button.dataset.timelineMode;
      $$(`[data-timeline-mode]`).forEach((item) => item.classList.toggle("is-active", item === button));
      renderTimelineView();
    }));
    $("#timeline-previous").addEventListener("click", () => moveTimelineDate(-1));
    $("#timeline-next").addEventListener("click", () => moveTimelineDate(1));
    $("#timeline-date").addEventListener("click", () => $("#timeline-date-input").showPicker ? $("#timeline-date-input").showPicker() : $("#timeline-date-input").click());
    $("#timeline-date-input").addEventListener("change", (event) => {
      if (!event.target.value) return;
      state.selectedDate = parseDate(event.target.value);
      state.selectedActivityId = null;
      renderTimelineView();
    });
    $("#jump-today").addEventListener("click", () => {
      state.selectedDate = new Date();
      state.selectedWeekStart = startOfWeek(new Date());
      state.selectedActivityId = null;
      renderTimelineView();
      if (state.view === "weekly") renderWeeklyView();
    });
    $("#ai-settings").addEventListener("click", openAiDialog);
    $("#ai-provider").addEventListener("change", updateAiProviderFields);
    $("#test-ai-connection").addEventListener("click", testAiConnection);
    $("#ai-test-status").addEventListener("click", () => {
      if (state.lastError) openErrorDialog();
    });
    $("#capture-state").addEventListener("click", openErrorDialog);
    $("#copy-error").addEventListener("click", async () => {
      if (!state.lastError) return;
      try {
        await navigator.clipboard.writeText(state.lastError);
        $("#copy-error").textContent = "Copied";
        window.setTimeout(() => { $("#copy-error").textContent = "Copy details"; }, 1500);
      } catch (_error) {
        $("#copy-error").textContent = "Select text above";
      }
    });
    $("#add-activity").addEventListener("click", openActivityDialog);
    $("#record-toggle").addEventListener("click", toggleRecording);
    $("#activity-form").addEventListener("submit", saveActivityFromForm);
    $("#ai-form").addEventListener("submit", saveAiSettings);
    $("#week-previous").addEventListener("click", () => moveWeek(-1));
    $("#week-next").addEventListener("click", () => moveWeek(1));
    $("#week-current").addEventListener("click", () => {
      state.selectedWeekStart = startOfWeek(new Date());
      state.selectedDate = new Date();
      renderWeeklyView();
    });
    $("#week-title").addEventListener("click", () => {
      state.selectedWeekStart = startOfWeek(new Date());
      state.selectedDate = new Date();
      renderWeeklyView();
    });
    $("#weekly-notes").addEventListener("input", (event) => {
      state.notes[dateKey(state.selectedWeekStart)] = event.target.value;
      $("#save-note-state").textContent = "Saving…";
      window.clearTimeout(window.__dayflowNoteSave);
      window.__dayflowNoteSave = window.setTimeout(() => {
        saveState();
        $("#save-note-state").textContent = "Saved locally";
      }, 280);
    });
    $("#weekly-notes").addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        saveState();
        $("#save-note-state").textContent = "Saved locally";
        event.preventDefault();
      }
    });
    window.setInterval(updateRecordingButton, 1000);
  };

  bindEvents();
  updateAiSourceLabel();
  renderTimelineView();
  renderWeeklyView();
  loadDesktopData();
  installLockStateListener();
})();
