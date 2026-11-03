import type { ExecutableTool } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { TOOL_ICONS } from '@proj-airi/stage-ui/tools/icons'
import { createMcpTools } from '@proj-airi/stage-ui/tools/mcp'
import { defineStore } from 'pinia'

import { electronMcpCallTool, electronMcpListTools } from '../../../shared/eventa'

export const useTamagotchiMcpToolsStore = defineStore('tamagotchi-mcp-tools', () => {
  const llmToolsStore = useLlmToolsStore()
  const listMcpTools = useElectronEventaInvoke(electronMcpListTools)
  const callMcpTool = useElectronEventaInvoke(electronMcpCallTool)
  const toolIdPrefix = 'mcp:'

  function registeredToolIds() {
    return llmToolsStore.tools
      .filter(tool => tool.id.startsWith(toolIdPrefix))
      .map(tool => tool.id)
  }

  /**
   * Mounts the two MCP wrapper tools only when a server can answer.
   *
   * With no server configured they can only ever return an empty list, yet they would sit in
   * every request as two always-on tools. A failed probe keeps them: a server that is merely
   * down may come back within the same session, and hiding the tool would hide that recovery.
   */
  async function refresh() {
    const available = await listMcpTools().catch(() => null)
    if (Array.isArray(available) && available.length === 0) {
      dispose()
      return
    }

    const tools = await Promise.all(createMcpTools({
      listTools: () => listMcpTools(),
      callTool: payload => callMcpTool(payload),
    }))

    llmToolsStore.removeToolsByIds(...registeredToolIds())
    llmToolsStore.addTools(...tools.map(tool => ({
      ...tool,
      icon: TOOL_ICONS.mcp,
      id: `${toolIdPrefix}${tool.function.name}`,
    } satisfies ExecutableTool)))
  }

  function dispose() {
    llmToolsStore.removeToolsByIds(...registeredToolIds())
  }

  return {
    dispose,
    refresh,
  }
}, {
  synced: {
    actions: ['dispose', 'refresh'],
    state: false,
  },
})
