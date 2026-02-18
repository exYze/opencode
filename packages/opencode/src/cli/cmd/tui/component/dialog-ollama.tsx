import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useSDK } from "../context/sdk"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "../context/theme"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogModel } from "./dialog-model"
import { TextAttributes } from "@opentui/core"

function formatSize(bytes: number) {
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(1)}GB`
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(0)}MB`
}

function providerIdFromUrl(url: string) {
  const match = url.match(/\/\/([^:/]+)(?::(\d+))?/)
  if (!match) return "ollama"
  const host = match[1]
  if (host === "localhost" || host === "127.0.0.1") return "ollama"
  return `ollama-${host.replace(/\./g, "-")}${match[2] && match[2] !== "11434" ? `-${match[2]}` : ""}`
}

function providerNameFromUrl(url: string) {
  const match = url.match(/\/\/([^:/]+)(?::(\d+))?/)
  if (!match) return "Ollama"
  const host = match[1]
  const port = match[2] ?? "11434"
  if (host === "localhost" || host === "127.0.0.1") return `Ollama (localhost:${port})`
  return `Ollama (${host}:${port})`
}

export function DialogOllamaServers() {
  const sync = useSync()
  const dialog = useDialog()

  const servers = createMemo(() => {
    const result: { id: string; url: string; modelCount: number }[] = []
    for (const provider of sync.data.provider) {
      if (!provider.id.startsWith("ollama")) continue
      const modelUrl = Object.values(provider.models)[0]?.api?.url
      if (!modelUrl) continue
      const base = modelUrl.replace(/\/v1\/?$/, "")
      result.push({
        id: provider.id,
        url: base,
        modelCount: Object.keys(provider.models).length,
      })
    }
    return result
  })

  const options = createMemo(() => {
    const items: Parameters<typeof DialogSelect>[0]["options"] = [
      {
        title: "Add new server",
        value: "add",
        description: "+",
        category: "Actions",
        onSelect() {
          dialog.replace(() => <DialogOllamaUrl />)
        },
      },
    ]

    for (const server of servers()) {
      items.push({
        title: server.url,
        value: server.id,
        description: `${server.modelCount} model${server.modelCount !== 1 ? "s" : ""}`,
        category: "Configured servers",
        onSelect() {
          dialog.replace(() => <DialogOllamaModels url={server.url} providerID={server.id} />)
        },
      })
    }

    return items
  })

  return <DialogSelect title="Ollama servers" options={options()} />
}

function DialogOllamaUrl() {
  const dialog = useDialog()

  return (
    <DialogPrompt
      title="Ollama server URL"
      placeholder="http://localhost:11434"
      value="http://localhost:11434"
      onConfirm={(value) => {
        const url = value.trim()
        if (!url) return
        const base = url.replace(/\/+$/, "").replace(/\/v1\/?$/, "")
        const providerID = providerIdFromUrl(base)
        dialog.replace(() => <DialogOllamaModels url={base} providerID={providerID} />)
      }}
    />
  )
}

interface OllamaModel {
  name: string
  size: number
  parameter_size?: string
  quantization_level?: string
}

function DialogOllamaModels(props: { url: string; providerID: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const { theme } = useTheme()
  const [models, setModels] = createSignal<OllamaModel[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)

  onMount(async () => {
    const params = new URLSearchParams({ url: props.url })
    const response = await fetch(`${sdk.url}/provider/ollama/discover?${params}`).catch((err) => {
      setError(`Failed to connect: ${err.message}`)
      setLoading(false)
      return null
    })
    if (!response) return
    if (!response.ok) {
      const text = await response.text()
      setError(text || `Server returned ${response.status}`)
      setLoading(false)
      return
    }
    const data = (await response.json()) as { models: OllamaModel[] }
    setModels(data.models)
    setLoading(false)
  })

  async function saveModels(selected: OllamaModel[]) {
    const modelEntries: Record<string, any> = {}
    for (const model of selected) {
      modelEntries[model.name] = {
        name: model.name,
        tool_call: true,
        temperature: true,
        reasoning: false,
        attachment: false,
        options: {},
        limit: { context: 131072, output: 4096 },
        release_date: "2024-01-01",
      }
    }

    await sdk.client.config.update({
      config: {
        provider: {
          [props.providerID]: {
            name: providerNameFromUrl(props.url),
            api: `${props.url}/v1`,
            npm: "@ai-sdk/openai-compatible",
            env: [],
            models: modelEntries,
            options: {
              apiKey: "ollama",
            },
          },
        },
      },
    })
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
  }

  const options = createMemo(() => {
    const items: Parameters<typeof DialogSelect>[0]["options"] = []

    if (loading()) return items
    if (error()) return items

    const modelList = models()
    if (modelList.length === 0) return items

    items.push({
      title: "Add all models",
      value: "all",
      description: `(${modelList.length} models)`,
      category: "Actions",
      onSelect() {
        saveModels(modelList)
      },
    })

    for (const model of modelList) {
      const desc = [model.parameter_size, model.quantization_level, formatSize(model.size)].filter(Boolean).join(" · ")
      items.push({
        title: model.name,
        value: model.name,
        description: desc,
        category: "Available models",
        onSelect() {
          saveModels([model])
        },
      })
    }

    return items
  })

  return (
    <Show
      when={!loading()}
      fallback={
        <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              Discovering models
            </text>
            <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
              esc
            </text>
          </box>
          <text fg={theme.textMuted}>Connecting to {props.url}...</text>
        </box>
      }
    >
      <Show
        when={!error()}
        fallback={
          <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
            <box flexDirection="row" justifyContent="space-between">
              <text attributes={TextAttributes.BOLD} fg={theme.text}>
                Connection failed
              </text>
              <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
                esc
              </text>
            </box>
            <text fg={theme.error}>{error()}</text>
            <text fg={theme.textMuted}>Make sure Ollama is running at {props.url}</text>
          </box>
        }
      >
        <Show
          when={models().length > 0}
          fallback={
            <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
              <box flexDirection="row" justifyContent="space-between">
                <text attributes={TextAttributes.BOLD} fg={theme.text}>
                  No models found
                </text>
                <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
                  esc
                </text>
              </box>
              <text fg={theme.textMuted}>Pull models with `ollama pull &lt;model&gt;` and try again</text>
            </box>
          }
        >
          <DialogSelect title={`Models on ${props.url}`} options={options()} />
        </Show>
      </Show>
    </Show>
  )
}
