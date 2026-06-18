import type {
  ConversationMeta,
  Message,
  ModelInfo,
  PersonaDetail,
  RosterItem,
  WorkspaceFile,
} from "./types"

export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:5300"

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = ""
    try {
      detail = (await res.json()).error ?? ""
    } catch {
      /* ignore */
    }
    throw new Error(detail || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  roster: () => fetch(`${API_BASE}/api/participants`).then((r) => json<RosterItem[]>(r)),
  transcript: () => fetch(`${API_BASE}/api/transcript`).then((r) => json<Message[]>(r)),
  workspace: () => fetch(`${API_BASE}/api/workspace`).then((r) => json<WorkspaceFile[]>(r)),

  sendMessage: (text: string, images?: string[]) =>
    fetch(`${API_BASE}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...(images && images.length > 0 ? { images } : {}) }),
    }).then((r) => json<{ accepted: boolean }>(r)),

  setActive: (id: string, active: boolean) =>
    fetch(`${API_BASE}/api/participants/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    }).then((r) => json<RosterItem>(r)),

  setParallel: (id: string, parallel: boolean) =>
    fetch(`${API_BASE}/api/participants/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parallel }),
    }).then((r) => json<RosterItem>(r)),

  kick: (id: string) =>
    fetch(`${API_BASE}/api/participants/${id}`, { method: "DELETE" }).then((r) => {
      if (!r.ok && r.status !== 204) throw new Error(`${r.status}`)
    }),

  participant: (id: string) =>
    fetch(`${API_BASE}/api/participants/${id}`).then((r) => json<PersonaDetail>(r)),

  models: () =>
    fetch(`${API_BASE}/api/models`).then((r) =>
      json<{ models: ModelInfo[]; allowCloud: boolean }>(r),
    ),

  updateAgent: (
    id: string,
    patch: {
      name?: string
      systemPrompt?: string
      tools?: string[]
      color?: string
      icon?: string
      model?: string | null
      thinkingLevel?: string | null
    },
  ) =>
    fetch(`${API_BASE}/api/participants/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<RosterItem>(r)),

  reorder: (order: string[]) =>
    fetch(`${API_BASE}/api/participants/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order }),
    }).then((r) => json<RosterItem[]>(r)),

  create: (body: {
    name: string
    systemPrompt: string
    tools?: string[]
    color?: string
    icon?: string
    id?: string
  }) =>
    fetch(`${API_BASE}/api/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<RosterItem>(r)),

  abort: () => fetch(`${API_BASE}/api/abort`, { method: "POST" }).then((r) => json(r)),

  steerMessage: (text: string, target: string) =>
    fetch(`${API_BASE}/api/messages/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, target }),
    }).then((r) => json<{ ok: boolean; target: string; text: string }>(r)),

  compact: (id: string) =>
    fetch(`${API_BASE}/api/participants/${id}/compact`, { method: "POST" }).then((r) =>
      json<{ summary: string; tokensBefore: number }>(r),
    ),

  exportAgent: (id: string) =>
    fetch(`${API_BASE}/api/participants/${id}/export`).then((r) => r.blob()),

  settings: () =>
    fetch(`${API_BASE}/api/settings`).then((r) =>
      json<{ chaining: boolean; defaultAgent: string | null }>(r),
    ),

  setChaining: (chaining: boolean) =>
    fetch(`${API_BASE}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chaining }),
    }).then((r) => json<{ chaining: boolean; defaultAgent: string | null }>(r)),

  setDefaultAgent: (defaultAgent: string | null) =>
    fetch(`${API_BASE}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultAgent }),
    }).then((r) => json<{ chaining: boolean; defaultAgent: string | null }>(r)),

  conversations: () =>
    fetch(`${API_BASE}/api/conversations`).then((r) =>
      json<{ currentId: string; list: ConversationMeta[] }>(r),
    ),

  newConversation: (title?: string) =>
    fetch(`${API_BASE}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(title ? { title } : {}),
    }).then((r) => json<ConversationMeta>(r)),

  loadConversation: (id: string) =>
    fetch(`${API_BASE}/api/conversations/${id}/load`, { method: "POST" }).then((r) =>
      json<{ ok: boolean }>(r),
    ),

  renameConversation: (id: string, title: string) =>
    fetch(`${API_BASE}/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }).then((r) => json<{ ok: boolean }>(r)),

  deleteConversation: (id: string) =>
    fetch(`${API_BASE}/api/conversations/${id}`, { method: "DELETE" }).then((r) => {
      if (!r.ok && r.status !== 204) throw new Error(`${r.status}`)
    }),
}
