import { readdir } from 'fs/promises'
import path from 'path'
import type { UnocssPluginContext, UserConfig, UserConfigDefaults } from '@unocss/core'
import { notNull } from '@unocss/core'
import { sourceObjectFields, sourcePluginFactory } from 'unconfig/presets'
import presetUno from '@unocss/preset-uno'
import { resolveOptions as resolveNuxtOptions } from '../../nuxt/src/options'
import { createNanoEvents } from '../../core/src/utils/events'
import { createContext, isCssId } from './integration'
import { isSubdir } from './utils'
import { log } from './log'

export class ContextLoader {
  public cwd: string
  public ready: Promise<void>
  public defaultContext: UnocssPluginContext<UserConfig<any>>
  public contextsMap = new Map<string, UnocssPluginContext<UserConfig<any>> | null>()
  public configSources: string[] = []

  private fileContextCache = new Map<string, UnocssPluginContext<UserConfig<any>> | null>()
  private configExistsCache = new Map<string, boolean>()
  private defaultUnocssConfig: UserConfigDefaults = {
    presets: [presetUno()],
  }

  public events = createNanoEvents<{
    reload: () => void
    unload: (context: UnocssPluginContext<UserConfig<any>>) => void
    contextLoaded: (context: UnocssPluginContext<UserConfig<any>>) => void
    contextReload: (context: UnocssPluginContext<UserConfig<any>>) => void
    contextUnload: (context: UnocssPluginContext<UserConfig<any>>) => void
  }>()

  constructor(cwd: string) {
    this.cwd = cwd
    this.defaultContext = createContext(this.defaultUnocssConfig)

    this.ready = this.reload()
      .then(async () => {
        await this.defaultContext.ready
      })
  }

  isTarget(id: string) {
    return isSubdir(this.cwd, id)
  }

  get contexts() {
    return Array.from(new Set(this.contextsMap.values())).filter(notNull)
  }

  async reload() {
    this.ready = this._reload()
    await this.ready
    this.events.emit('reload')
  }

  private async _reload() {
    const dirs = Array.from(this.contextsMap.keys())
    await Promise.allSettled(Array.from(dirs).map(dir => this.unloadContext(dir)))

    this.fileContextCache.clear()
    this.configExistsCache.clear()

    for (const dir of dirs)
      await this.loadContextInDirectory(dir)
    if (!dirs.length)
      await this.loadContextInDirectory(this.cwd)
  }

  async unload(configDir: string) {
    const context = this.contextsMap.get(configDir)
    if (!context)
      return

    this.contextsMap.delete(configDir)

    for (const [path, ctx] of this.fileContextCache) {
      if (ctx === context)
        this.fileContextCache.delete(path)
    }
    this.events.emit('unload', context)
  }

  async unloadContext(configDir: string) {
    const context = this.contextsMap.get(configDir)
    if (!context)
      return

    this.contextsMap.delete(configDir)

    for (const [path, ctx] of this.fileContextCache) {
      if (ctx === context)
        this.fileContextCache.delete(path)
    }

    this.events.emit('contextUnload', context)
    this.events.emit('reload')
  }

  async configExists(dir: string) {
    if (!this.configExistsCache.has(dir)) {
      const files = await readdir(dir)
      this.configExistsCache.set(dir, files.some(f => /^(vite|svelte|astro|iles|nuxt|unocss|uno)\.config/.test(f)))
    }
    return this.configExistsCache.get(dir)!
  }

  async loadContextInDirectory(dir: string) {
    const cached = this.contextsMap.get(dir)
    if (cached !== undefined)
      return cached

    const load = async () => {
      log.appendLine('\n-----------')
      log.appendLine(`🛠 Resolving config for ${dir}`)

      // @ts-expect-error support global utils
      globalThis.defineNuxtConfig = config => config

      const context = createContext(
        dir,
        this.defaultUnocssConfig,
        [
          sourcePluginFactory({
            files: [
              'vite.config',
              'svelte.config',
              'iles.config',
            ],
            targetModule: 'unocss/vite',
            parameters: [{ command: 'serve', mode: 'development' }],
          }),
          sourcePluginFactory({
            files: [
              'astro.config',
            ],
            targetModule: 'unocss/astro',
          }),
          sourceObjectFields({
            files: 'nuxt.config',
            fields: 'unocss',
          }),
        ],
        (result) => {
          if (result.sources.some(s => s.includes('nuxt.config')))
            resolveNuxtOptions(result.config)
        },
      )

      context.updateRoot(dir)
      let sources = []
      try {
        sources = (await context.ready).sources
      }
      catch (e: any) {
        log.appendLine(`⚠️ Error on loading config. Config directory: ${dir}`)
        log.appendLine(String(e.stack ?? e))
        console.error(e)
        return null
      }

      this.configSources = sources

      if (!sources.length)
        return null

      const baseDir = path.dirname(sources[0])
      if (baseDir !== dir) {
        // exists on upper level, skip
        this.contextsMap.set(dir, null)
        return null
      }

      context.onReload(() => {
        for (const [path, ctx] of this.fileContextCache) {
          if (ctx === context || !ctx)
            this.fileContextCache.delete(path)
        }
        this.configExistsCache.clear()
        this.events.emit('contextReload', context)
      })

      for (const [path, ctx] of this.fileContextCache) {
        if (!ctx)
          this.fileContextCache.delete(path)
      }

      this.events.emit('contextLoaded', context)

      log.appendLine(`🛠 New configuration loaded from\n${sources.map(s => `  - ${s}`).join('\n')}`)
      log.appendLine(`ℹ️ ${context.uno.config.presets.length} presets, ${context.uno.config.rulesSize} rules, ${context.uno.config.shortcuts.length} shortcuts, ${context.uno.config.variants.length} variants, ${context.uno.config.transformers?.length || 0} transformers loaded`)

      if (!sources.some(i => i.match(/\buno(css)?\.config\./))) {
        log.appendLine('💡 To have the best IDE experience, it\'s recommended to move UnoCSS configurations into a standalone `uno.config.ts` file at the root of your project.')
        log.appendLine('👉 Learn more at https://unocss.dev/guide/config-file')
      }

      return context
    }

    const context = await load()
    if (!this.contextsMap.has(dir))
      this.contextsMap.set(dir, context)
    this.fileContextCache.clear()
    this.events.emit('reload')

    log.appendLine(`🗂️ All context: ${Array.from(this.contextsMap.keys()).join(', ')}`)

    return context
  }

  async resolveClosestContext(code: string, file: string) {
    if (!this.contextsMap.size)
      return undefined

    if (file.match(/[\/](node_modules|dist|\.temp|\.cache)[\/]/g))
      return undefined

    if (this.fileContextCache.has(file))
      return this.fileContextCache.get(file)

    const entries = Array.from(this.contextsMap.entries()).sort((a, b) => b[0].length - a[0].length)
    for (const [configDir, context] of entries) {
      if (!context)
        continue

      if (!isSubdir(configDir, file))
        continue

      if (!context.filter(code, file) && !isCssId(file))
        continue

      this.fileContextCache.set(file, context)
      return context
    }

    for (const [configDir, context] of entries) {
      if (!context)
        continue

      if (isSubdir(configDir, file)) {
        this.fileContextCache.set(file, context)
        return context
      }
    }

    return this.defaultContext
  }
}
