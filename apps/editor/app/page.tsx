'use client'

import {
  Editor,
  type SidebarTab,
  ViewerToolbarLeft,
  ViewerToolbarRight,
} from '@aedifex/editor'
import { AIChatPanel } from '@aedifex/editor/components/ai'

const SIDEBAR_TABS: (SidebarTab & { component: React.ComponentType })[] = [
  {
    id: 'site',
    label: 'Scene',
    component: () => null,
  },
  {
    id: 'ai-chat',
    label: 'AI Chat',
    component: AIChatPanel,
  },
]

export default function Home() {
  return (
    <div className="h-screen w-screen">
      <Editor
        layoutVersion="v2"
        projectId="local-editor"
        sidebarTabs={SIDEBAR_TABS}
        viewerToolbarLeft={<ViewerToolbarLeft />}
        viewerToolbarRight={<ViewerToolbarRight />}
      />
    </div>
  )
}
