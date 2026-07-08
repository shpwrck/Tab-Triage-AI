import { getSettings } from "./storage.js";
import { LLMError } from "./llm/index.js";
import { runQuotaLimitedTriage, TriageQuotaError } from "./triage_quota.js";
import { saveTriageCache } from "./triage_cache.js";
import { setTriageRunning } from "./badge.js";
import { normalizeTriageGroups } from "./triage_normalize.js";

export const POPUP_TRIAGE_STATE_KEY = "tt_popup_triage_job";

const RUNNING_STATE_MAX_AGE_MS = 10 * 60_000;
const activePopupJobs = new Set();

export async function readPopupTriageState() {
  const state = await readRawState();
  if (!state) return null;
  if (state.status === "running" && isStaleRunningState(state)) {
    const stale = {
      ...state,
      status: "error",
      completedAt: Date.now(),
      error: "Triage stopped before it returned. Try again.",
    };
    await writeState(stale);
    await setTriageRunning(false).catch(() => {});
    return stale;
  }
  return state;
}

export async function startPopupTriage({ tabs, windowId } = {}) {
  const existing = await readPopupTriageState();
  if (existing?.status === "running") {
    if (activePopupJobs.has(existing.jobId)) return existing;
    await writeState({
      ...existing,
      status: "error",
      completedAt: Date.now(),
      error: "Triage stopped before it returned. Try again.",
    });
    await setTriageRunning(false).catch(() => {});
  }

  const selectedTabs = sanitizeTabs(tabs);
  if (selectedTabs.length < 2) {
    const failed = {
      jobId: makeJobId(),
      status: "error",
      windowId: windowId ?? inferWindowId(selectedTabs),
      startedAt: Date.now(),
      completedAt: Date.now(),
      error: "Select at least 2 tabs to triage.",
    };
    await writeState(failed);
    return failed;
  }

  const job = {
    jobId: makeJobId(),
    status: "running",
    windowId: windowId ?? inferWindowId(selectedTabs),
    startedAt: Date.now(),
    tabCount: selectedTabs.length,
  };
  await writeState(job);
  activePopupJobs.add(job.jobId);
  runPopupTriageJob({ jobId: job.jobId, tabs: selectedTabs, windowId: job.windowId }).catch(e => {
    console.warn("[popup-triage] job failed outside normal handler", e?.message ?? e);
  });
  return job;
}

async function runPopupTriageJob({ jobId, tabs, windowId }) {
  await setTriageRunning(true).catch(() => {});
  try {
    const settings = await getSettings();
    if (!settings.llm?.apiKey) {
      throw new LLMError("Add an API key in Settings first.");
    }

    const { result: groups } = await runQuotaLimitedTriage({
      settings,
      tabs,
      onPreflight: async ({ cap }) => {
        if (cap.applied) {
          await updateCurrentJob(jobId, { notice: cap.message });
        }
      },
      afterTriage: async ({ rawGroups, tabs: toSend }) => {
        const groups = buildPopupGroups(rawGroups, toSend);
        await saveTriageCache({ windowId: windowId ?? null, groups }).catch(() => {});
        return groups;
      },
    });
    await finishCurrentJob(jobId, {
      status: "success",
      completedAt: Date.now(),
      groups,
    });
  } catch (e) {
    await finishCurrentJob(jobId, {
      status: "error",
      completedAt: Date.now(),
      error: userFacingError(e),
      errorDetails: userFacingErrorDetails(e),
    });
  } finally {
    const current = await readRawState();
    if (current?.jobId === jobId) {
      await setTriageRunning(false).catch(() => {});
    }
    activePopupJobs.delete(jobId);
  }
}

function buildPopupGroups(rawGroups, tabs) {
  return normalizeTriageGroups({ rawGroups, tabs }).map(g => ({
    ...g,
    status: null,
  }));
}

async function finishCurrentJob(jobId, patch) {
  await updateCurrentJob(jobId, patch);
}

async function updateCurrentJob(jobId, patch) {
  const current = await readRawState();
  if (current?.jobId !== jobId) return false;
  await writeState({ ...current, ...patch });
  return true;
}

async function readRawState() {
  const { [POPUP_TRIAGE_STATE_KEY]: state } = await chrome.storage.local.get(POPUP_TRIAGE_STATE_KEY);
  return state && typeof state === "object" ? state : null;
}

async function writeState(state) {
  await chrome.storage.local.set({ [POPUP_TRIAGE_STATE_KEY]: state });
}

function sanitizeTabs(tabs) {
  return (Array.isArray(tabs) ? tabs : [])
    .filter(t => typeof t?.id === "number" && typeof t.url === "string" && /^https?:/.test(t.url))
    .map(t => ({
      id: t.id,
      windowId: typeof t.windowId === "number" ? t.windowId : null,
      title: t.title || t.url,
      url: t.url,
      favIconUrl: t.favIconUrl || "",
    }));
}

function inferWindowId(tabs) {
  const first = tabs.find(t => typeof t.windowId === "number");
  return first?.windowId ?? null;
}

function isStaleRunningState(state) {
  return typeof state.startedAt === "number" && Date.now() - state.startedAt > RUNNING_STATE_MAX_AGE_MS;
}

function makeJobId() {
  return `popup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function userFacingError(e) {
  if (e instanceof LLMError || e instanceof TriageQuotaError) return e.message;
  return `Unexpected error: ${e?.message ?? e}`;
}

function userFacingErrorDetails(e) {
  if (e instanceof LLMError) return e.details || "";
  return "";
}
