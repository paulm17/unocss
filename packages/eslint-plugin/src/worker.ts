import process from 'node:process'
import { loadConfig } from '@unocss/config'
import type { UnoGenerator } from '@unocss/core'
import { createGenerator } from '@unocss/core'
import { runAsWorker } from 'synckit'
import { sortRules } from '../../shared-integration/src/sort-rules'

let promise: Promise<UnoGenerator<any>> | undefined

// bypass icon rules in ESLint
process.env.ESLINT ||= 'true'

async function _getGenerator() {
  const { config, sources } = await loadConfig()
  if (!sources.length)
    throw new Error('[@unocss/eslint-plugin] No config file found, create a `uno.config.ts` file in your project root and try again.')
  return createGenerator({
    ...config,
    warn: false,
  })
}

export async function getGenerator() {
  promise = promise || _getGenerator()
  return await promise
}

async function actionSort(classes: string) {
  return await sortRules(classes, await getGenerator())
}

async function actionBlocklist(classes: string, id?: string) {
  const uno = await getGenerator()
  const extracted = await uno.applyExtractors(classes, id)
  return [...extracted.values()].filter(i => uno.isBlocked(i))
}

export function run(action: 'sort', classes: string): string
export function run(action: 'blocklist', classes: string, id?: string): string[]
export function run(action: string, ...args: any[]): any {
  switch (action) {
    case 'sort':
      // @ts-expect-error cast
      return actionSort(...args)
    case 'blocklist':
      // @ts-expect-error cast
      return actionBlocklist(...args)
  }
}

runAsWorker(run as any)
