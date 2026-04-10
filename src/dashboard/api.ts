let apiKey: string | null = sessionStorage.getItem("haiflow_api_key");

export class AuthError extends Error {
  constructor() {
    super("Unauthorized");
  }
}

export function getApiKey() {
  return apiKey;
}

export function setApiKey(key: string) {
  apiKey = key;
  sessionStorage.setItem("haiflow_api_key", key);
}

export function clearApiKey() {
  apiKey = null;
  sessionStorage.removeItem("haiflow_api_key");
}

async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options?.headers || {}),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "Content-Type": "application/json",
    },
  });
  if (res.status === 401) {
    clearApiKey();
    throw new AuthError();
  }
  return res;
}

export async function getSessions() {
  const res = await apiFetch("/sessions");
  return res.json();
}

export async function getStatus(session: string) {
  const res = await apiFetch(`/status?session=${session}`);
  return res.json();
}

export async function getQueue(session: string) {
  const res = await apiFetch(`/queue?session=${session}`);
  return res.json();
}

export async function clearQueue(session: string) {
  const res = await apiFetch(`/queue?session=${session}`, { method: "DELETE" });
  return res.json();
}

export async function getResponses(session: string) {
  const res = await apiFetch(`/responses?session=${session}`);
  return res.json();
}

export async function clearResponses(session: string) {
  const res = await apiFetch(`/responses?session=${session}`, { method: "DELETE" });
  return res.json();
}

export async function getResponse(session: string, id: string) {
  const res = await apiFetch(`/responses/${id}?session=${session}`);
  return { status: res.status, data: await res.json() };
}

export async function trigger(session: string, prompt: string, source?: string) {
  const res = await apiFetch("/trigger", {
    method: "POST",
    body: JSON.stringify({ prompt, session, source: source || "dashboard" }),
  });
  return res.json();
}

export async function startSession(session: string, cwd: string) {
  const res = await apiFetch("/session/start", {
    method: "POST",
    body: JSON.stringify({ session, cwd }),
  });
  return { status: res.status, data: await res.json() };
}

export async function stopSession(session: string) {
  const res = await apiFetch("/session/stop", {
    method: "POST",
    body: JSON.stringify({ session }),
  });
  return { status: res.status, data: await res.json() };
}

export async function removeSession(session: string) {
  const res = await apiFetch("/session/remove", {
    method: "POST",
    body: JSON.stringify({ session }),
  });
  return { status: res.status, data: await res.json() };
}

export async function getPipeline() {
  const res = await apiFetch("/pipeline");
  return res.json();
}

export async function getEvents(limit = 50) {
  const res = await apiFetch(`/events?limit=${limit}`);
  return res.json();
}

export async function getPipelineTopics() {
  const res = await apiFetch("/pipeline/topics");
  return res.json();
}

export async function publishEvent(topic: string, message: string, session?: string) {
  const res = await apiFetch("/publish", {
    method: "POST",
    body: JSON.stringify({ topic, message, session }),
  });
  return res.json();
}
