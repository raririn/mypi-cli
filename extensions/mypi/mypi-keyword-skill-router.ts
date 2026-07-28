import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createKeywordSkillRouter } from '../gui-control/keyword-skill-routing.ts'

export {
  createKeywordSkillRouter,
  loadKeywordSkillRegistry,
  resolveKeywordSkill,
  type KeywordSkillMatcher,
  type KeywordSkillRegistry,
  type KeywordSkillResolution,
  type KeywordSkillRoute,
  type KeywordSkillRouter,
} from '../gui-control/keyword-skill-routing.ts'

/** Lazily route matching user input through hidden skills without adding idle model context. */
export default function keywordSkillRouter(pi: ExtensionAPI): void {
  const router = createKeywordSkillRouter(pi)

  pi.on('input', (event, ctx) => {
    const notify = (message: string) => ctx.ui.notify(message, 'warning')
    return event.source === 'extension'
      ? router.routeExtensionInput(event.text, notify)
      : router.routeInteractiveInput(event.text, notify)
  })
}
