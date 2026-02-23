import type { Provider } from '../types'
import type { IWhatsAppAdapter } from './interface'
import { MetaAdapter } from './meta'
import { EvolutionAdapter } from './evolution'
import { UazapiAdapter } from './uazapi'

/** Returns the adapter instance for a given provider. */
export function getAdapter(provider: Provider): IWhatsAppAdapter {
  switch (provider) {
    case 'META_CLOUD':
      return new MetaAdapter()
    case 'EVOLUTION':
      return new EvolutionAdapter()
    case 'UAZAPI':
      return new UazapiAdapter()
    default: {
      const _exhaustive: never = provider
      throw new Error(`Provider desconhecido: ${String(_exhaustive)}`)
    }
  }
}
