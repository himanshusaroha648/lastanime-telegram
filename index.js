import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

dotenv.config();

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const MAX_ITEMS_PER_TABLE = 25;
const STATE_DIR = path.resolve(process.cwd(), "state");
const STATE_FILE = path.join(STATE_DIR, "sent-notifications.json");
const WATCH_NOW_URL = "http://bit.ly/4tyJJDF";
const APP_DOWNLOAD_URL = "https://bit.ly/3QogoNR";
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  TELEGRAM_BOT_TOKEN,
  CHANNEL_ID,
  CHHANEL_ID,
} = process.env;

const telegramChatId = CHANNEL_ID || CHHANEL_ID;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !TELEGRAM_BOT_TOKEN || !telegramChatId) {
  console.error("Missing required environment values.");
  console.error(
    "Required: SUPABASE_URL, SUPABASE_ANON_KEY, TELEGRAM_BOT_TOKEN, and CHANNEL_ID (or CHHANEL_ID)."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
  },
});

const defaultState = {
  lastCheckedAt: new Date(Date.now() - POLL_INTERVAL_MS).toISOString(),
  lastNotification: null,
};

let appState = defaultState;
let lastCheckedAt = new Date(defaultState.lastCheckedAt);

function formatDateTime(date) {
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      lastCheckedAt:
        typeof parsed?.lastCheckedAt === "string" ? parsed.lastCheckedAt : defaultState.lastCheckedAt,
      lastNotification: parsed?.lastNotification ?? null,
    };
  } catch {
    return { ...defaultState };
  }
}

async function saveState(nextState) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
}

function formatEpisodeLabel(item) {
  const season = String(item.season).padStart(2, "0");
  const episode = String(item.episode).padStart(2, "0");
  return `S${season}E${episode}`;
}

function getItemKey(tableName, item) {
  if (tableName === "episodes") {
    return `${item.series_slug}::${item.season}::${item.episode}`;
  }

  return item.slug;
}

function buildPreviousIndex(items, tableName) {
  const index = new Map();

  for (const item of items || []) {
    index.set(getItemKey(tableName, item), item.updated_at);
  }

  return index;
}

function filterNewOrChangedItems(items, tableName, previousItems) {
  const previousIndex = buildPreviousIndex(previousItems, tableName);

  return items.filter((item) => previousIndex.get(getItemKey(tableName, item)) !== item.updated_at);
}

function buildEpisodeKey(item) {
  return `${item.series_slug}|S${String(item.season).padStart(2, "0")}|E${String(item.episode).padStart(2, "0")}`;
}

function buildEpisodeKeys(episodes) {
  return [...new Set((episodes || []).map((item) => buildEpisodeKey(item)))];
}

function formatUpdateDate(date) {
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatNumberIcon(index) {
  const icons = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
  return icons[index] || `${index + 1}.`;
}

function compressEpisodeNumbers(episodes) {
  if (!episodes.length) {
    return [];
  }

  const numbers = [...new Set(episodes.map((item) => item.episode))].sort((a, b) => a - b);
  const ranges = [];
  let rangeStart = numbers[0];
  let previous = numbers[0];

  for (let index = 1; index < numbers.length; index += 1) {
    const current = numbers[index];

    if (current === previous + 1) {
      previous = current;
      continue;
    }

    ranges.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`);
    rangeStart = current;
    previous = current;
  }

  ranges.push(rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`);
  return ranges;
}

function groupEpisodes(episodes) {
  const groups = new Map();

  [...episodes]
    .sort((left, right) => {
      if (left.series_slug !== right.series_slug) {
        return left.series_slug.localeCompare(right.series_slug);
      }

      if (left.season !== right.season) {
        return left.season - right.season;
      }

      return left.episode - right.episode;
    })
    .forEach((episode) => {
      const key = `${episode.series_slug}::${episode.season}`;

      if (!groups.has(key)) {
        groups.set(key, { series_slug: episode.series_slug, season: episode.season, episodes: [] });
      }

      groups.get(key).episodes.push(episode);
    });

  return [...groups.values()];
}

async function fetchRecentUpdates(tableName, sinceIso, selectFields) {
  const { data, error } = await supabase
    .from(tableName)
    .select(selectFields)
    .gte("updated_at", sinceIso)
    .order("updated_at", { ascending: false })
    .limit(MAX_ITEMS_PER_TABLE);

  if (error) {
    throw new Error(`${tableName} query failed: ${error.message}`);
  }

  return data || [];
}

function buildMessage(movies, series, since, until) {
  const lines = [];
  lines.push("🎬 Database Update Alert");
  lines.push(`Window: ${formatDateTime(since)} to ${formatDateTime(until)}`);
  lines.push("");

  if (movies.length) {
    lines.push(`Movies updated: ${movies.length}`);
    movies.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.title} (slug: ${item.slug})`);
    });
    lines.push("");
  }

  if (series.length) {
    lines.push(`Series updated: ${series.length}`);
    series.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.title} (slug: ${item.slug})`);
    });
    lines.push("");
  }

  if (movies.length === 0 && series.length === 0) {
    lines.push("No table updates found.");
  }

  return lines.join("\n");
}

function buildEpisodeMessage(episodes, episodeTitleMap, until) {
  const lines = [];
  lines.push("🔥 New Anime Episode Updates!");
  lines.push("");
  lines.push(`📅 Update Date: ${formatUpdateDate(until)}`);
  lines.push("⏰ Freshly Updated");
  lines.push("");
  lines.push(`🎬 Total Series Updated: ${episodes.length}`);
  lines.push("");

  episodes.forEach((item, index) => {
    const seriesTitle = episodeTitleMap.get(item.series_slug) || item.series_slug;
    lines.push(
      `${formatNumberIcon(index)} ${seriesTitle} — ${formatEpisodeLabel(item)}`
    );
  });

  lines.push("");
  lines.push(`🌐 Watch Now: ${WATCH_NOW_URL}`);
  lines.push(`📥 App Download: ${APP_DOWNLOAD_URL}`);
  lines.push("");
  lines.push("🚀 Latest episodes are now live on LastAnime!");

  return lines.join("\n");
}

async function fetchSeriesTitleMapBySlugs(slugs) {
  if (!slugs.length) {
    return new Map();
  }

  const { data, error } = await supabase
    .from("series")
    .select("slug, title")
    .in("slug", slugs);

  if (error) {
    throw new Error(`series title lookup failed: ${error.message}`);
  }

  const map = new Map();
  for (const item of data || []) {
    map.set(item.slug, item.title);
  }

  return map;
}

async function sendTelegramMessage(text) {
  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: telegramChatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const result = await response.json();

  if (!response.ok || !result.ok) {
    const errorDescription = result?.description || "Telegram API request failed";
    throw new Error(errorDescription);
  }
}

async function recordNotification(payload) {
  appState = {
    lastCheckedAt: payload.windowEnd,
    lastNotification: payload,
  };

  lastCheckedAt = new Date(payload.windowEnd);
  await saveState(appState);
}

function startHttpServer() {
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      const body = {
        status: "ok",
        service: "lastanime-telegram",
        lastCheckedAt: appState.lastCheckedAt,
      };

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(`${JSON.stringify(body)}\n`);
      return;
    }

    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("lastanime-telegram bot is running\n");
  });

  server.listen(PORT, HOST, () => {
    console.log(`HTTP server listening on ${HOST}:${PORT}`);
  });
}

async function pollAndNotify() {
  const pollStartedAt = new Date();
  const since = new Date(lastCheckedAt);
  const sinceIso = since.toISOString();
  const previousSnapshot = appState.lastNotification || { movies: [], series: [], episodes: [], trackedEpisodes: [] };

  try {
    const [movies, series] = await Promise.all([
      fetchRecentUpdates("movies", sinceIso, "id, title, slug, updated_at"),
      fetchRecentUpdates("series", sinceIso, "id, title, slug, updated_at"),
    ]);

    const episodes = await fetchRecentUpdates(
      "episodes",
      sinceIso,
      "id, series_slug, season, episode, title, updated_at"
    );

    const previousTrackedEpisodeKeys = new Set(
      previousSnapshot.trackedEpisodes?.length
        ? previousSnapshot.trackedEpisodes
        : buildEpisodeKeys(previousSnapshot.episodes || [])
    );
    const currentEpisodeKeys = buildEpisodeKeys(episodes);
    const episodesToSend = episodes.filter(
      (item) => !previousTrackedEpisodeKeys.has(buildEpisodeKey(item))
    );

    if (episodesToSend.length === 0) {
      console.log(`[${new Date().toISOString()}] No updates found.`);
      await recordNotification({
        windowStart: since.toISOString(),
        windowEnd: pollStartedAt.toISOString(),
        sentAt: null,
        counts: { movies: 0, series: 0, episodes: 0 },
        movies: [],
        series: [],
        episodes,
        trackedEpisodes: currentEpisodeKeys,
        type: "no_updates",
      });
      return;
    }

    const episodeSeriesSlugs = [...new Set(episodesToSend.map((item) => item.series_slug))];
    const seriesTitleMap = await fetchSeriesTitleMapBySlugs(episodeSeriesSlugs);
    const episodeMessage = buildEpisodeMessage(episodesToSend, seriesTitleMap, pollStartedAt);
    await sendTelegramMessage(episodeMessage);

    await recordNotification({
      windowStart: since.toISOString(),
      windowEnd: pollStartedAt.toISOString(),
      sentAt: new Date().toISOString(),
      counts: { movies: 0, series: 0, episodes: episodesToSend.length },
      movies: [],
      series: [],
      episodes,
      trackedEpisodes: currentEpisodeKeys,
      sentItems: {
        movies: [],
        series: [],
        episodes: episodesToSend,
      },
      type: "sent",
    });

    console.log(
      `[${new Date().toISOString()}] Notified Telegram. Episodes: ${episodesToSend.length}`
    );
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Polling error:`, error.message);
  }
}

appState = await loadState();
lastCheckedAt = new Date(appState.lastCheckedAt || defaultState.lastCheckedAt);

startHttpServer();
console.log("Service started. Polling every 10 minutes...");

await pollAndNotify();
setInterval(pollAndNotify, POLL_INTERVAL_MS);
