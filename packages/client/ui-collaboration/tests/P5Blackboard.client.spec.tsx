// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CollaborationRoot } from '../src/client/CollaborationRoot.tsx'
import { createCollaborationDemoPort, createDemoRuns } from '../src/client/fixture.ts'
import { createCollaborationStore } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'

afterEach(cleanup)

describe('trimmed collaboration panel', () => {
  it('does not mount the retired blackboard or Lead-console surfaces', () => {
    const run = createDemoRuns().find(candidate => candidate.status === 'running')!
    const port = createCollaborationDemoPort([run])
    const instance = createCollaborationStore().create('trimmed-p5')
    const t: TranslateNS<'collaboration'> = key => key in zh ? zh[key as keyof typeof zh] : key
    const view = render(<CollaborationRoot
      open
      width={440}
      useSessions={vi.fn()}
      useWorkspaces={vi.fn()}
      useStore={select => useSyncExternalStore(
        listener => instance.subscribe(listener),
        () => select(instance.getSnapshot()),
      )}
      actions={instance.actions}
      useCollaboration={select => useSyncExternalStore(
        listener => port.source.subscribe(listener),
        () => select(port.source.getSnapshot()),
      )}
      refreshCollaboration={vi.fn(async () => undefined)}
      closeCollaboration={vi.fn()}
      t={t}
    />)

    expect(screen.queryByRole('tab', { name: zh['tabs.blackboard'] })).toBeNull()
    expect(screen.queryByRole('tab', { name: zh['tabs.controller'] })).toBeNull()
    expect(view.container.textContent).not.toContain(zh['blackboard.title'])
    expect(view.container.textContent).not.toContain(zh['controller.title'])
  })
})
