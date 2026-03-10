// ---------------------------------------------------------------------------
// TDD — UI Inbox: componente InboxFilters + ConversationList (seção 4)
//
// Cobre:
//   4a. Botão/área "Filtros" abre/fecha painel
//   4b. Seleção de provider atualiza lista
//   4c. Seleção de canal atualiza lista
//   4d. Preset de data aplica intervalo correto
//   4e. Período personalizado aplica intervalo correto
//   4f. Combinação provider + período funciona
//   4g. "Limpar filtros" volta para estado default
//   4h. Estado vazio mostra mensagem coerente com filtros aplicados
//   4i. Indicador visual de filtros ativos (chips/contador)
//   4j. Persistência em URL/query params (se implementado)
//
// Alvos de análise estática:
//   - app/whatsapp/inbox/components/InboxFilters.tsx  (a criar)
//   - app/whatsapp/inbox/components/ConversationList.tsx (existente — estender)
//   - app/whatsapp/inbox/page.tsx (integração)
//
// STATUS: RED — InboxFilters.tsx ainda não existe; ConversationList não tem
//         painel de filtros ainda. Testes falharão na fase TDD red.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(__dirname, '../../..')

function readSrc(rel: string): string {
  try {
    return readFileSync(resolve(ROOT, rel), 'utf-8')
  } catch {
    return '' // arquivo ausente → expects falharão claramente
  }
}

// ---------------------------------------------------------------------------
// Fontes dos componentes
// ---------------------------------------------------------------------------

const filtersSrc = readSrc('app/whatsapp/inbox/components/InboxFilters.tsx')
const listSrc = readSrc('app/whatsapp/inbox/components/ConversationList.tsx')
const pageSrc = readSrc('app/whatsapp/inbox/page.tsx')

// ---------------------------------------------------------------------------
// 4a. Botão/área "Filtros" abre/fecha painel
// ---------------------------------------------------------------------------

describe('InboxFilters — painel abre/fecha', () => {
  it('arquivo InboxFilters.tsx existe', () => {
    const exists = existsSync(resolve(ROOT, 'app/whatsapp/inbox/components/InboxFilters.tsx'))
    expect(exists).toBe(true)
  })

  it('tem estado para controlar visibilidade do painel (open/isOpen/show)', () => {
    expect(filtersSrc).toMatch(/isOpen|showFilters|open\b/)
  })

  it('tem botão que alterna visibilidade do painel', () => {
    // botão com onClick que alterna o estado
    expect(filtersSrc).toMatch(/onClick[\s\S]{0,50}set(IsOpen|ShowFilters|Open)|toggle.*filter/i)
  })

  it('painel (div/section) é renderizado condicionalmente', () => {
    expect(filtersSrc).toMatch(/isOpen|showFilters|open\b[\s\S]{0,200}return|&&[\s\S]{0,100}filter/i)
  })

  it('label/texto "Filtros" ou "Filtrar" visível no botão de abertura', () => {
    expect(filtersSrc).toMatch(/Filtros|Filtrar/i)
  })
})

// ---------------------------------------------------------------------------
// 4b. Seleção de provider
// ---------------------------------------------------------------------------

describe('InboxFilters — seleção de provider', () => {
  it('exibe opção META_CLOUD', () => {
    expect(filtersSrc).toContain('META_CLOUD')
  })

  it('exibe opção EVOLUTION', () => {
    expect(filtersSrc).toContain('EVOLUTION')
  })

  it('exibe opção UAZAPI', () => {
    expect(filtersSrc).toContain('UAZAPI')
  })

  it('tem handler para mudança de provider (onChange ou onClick)', () => {
    expect(filtersSrc).toMatch(/onProviderChange|onChange.*provider|provider.*onChange/i)
  })

  it('provider é passado via props ou callback para o pai', () => {
    // O componente recebe onFiltersChange ou callbacks específicos
    expect(filtersSrc).toMatch(/onFiltersChange|onProviderChange|provider.*prop/i)
  })
})

// ---------------------------------------------------------------------------
// 4c. Seleção de canal
// ---------------------------------------------------------------------------

describe('InboxFilters — seleção de canal', () => {
  it('renderiza seletor de canal (select ou dropdown)', () => {
    expect(filtersSrc).toMatch(/<select|channel.*select|Select.*channel/i)
  })

  it('tem handler para mudança de canal', () => {
    expect(filtersSrc).toMatch(/onChannelChange|onChange.*channel|channel.*onChange/i)
  })

  it('lista de canais é renderizada no seletor', () => {
    // Deve iterar sobre channels para popular as opções
    expect(filtersSrc).toMatch(/channels\.map|\.map.*channel/i)
  })

  it('canal selecionado produz channel_id no filtro', () => {
    expect(filtersSrc).toMatch(/channel_id/)
  })
})

// ---------------------------------------------------------------------------
// 4d. Preset de data
// ---------------------------------------------------------------------------

describe('InboxFilters — presets de data', () => {
  it('tem opção de preset last_7_days', () => {
    expect(filtersSrc).toMatch(/last_7_days|últimos.*7.*dias|últimos 7/i)
  })

  it('tem opção de preset last_month', () => {
    expect(filtersSrc).toMatch(/last_month|mês.*passado|último mês/i)
  })

  it('preset altera date_from e date_to no estado/callback', () => {
    expect(filtersSrc).toMatch(/date_from|date_to/)
  })
})

// ---------------------------------------------------------------------------
// 4e. Período personalizado
// ---------------------------------------------------------------------------

describe('InboxFilters — período personalizado', () => {
  it('tem inputs de data para date_from e date_to', () => {
    expect(filtersSrc).toMatch(/type=['"]date['"]|input.*date/i)
  })

  it('date_from e date_to são controlados por estado', () => {
    expect(filtersSrc).toMatch(/date_from|dateFrom/)
    expect(filtersSrc).toMatch(/date_to|dateTo/)
  })
})

// ---------------------------------------------------------------------------
// 4f. Combinação provider + período funciona
// ---------------------------------------------------------------------------

describe('InboxFilters — combinação provider + período', () => {
  it('estado de filtros guarda provider E datas simultaneamente', () => {
    // O objeto de filtros deve ter campos para ambos
    const hasProvider = filtersSrc.includes('provider')
    const hasDate = filtersSrc.match(/date_from|date_to|dateFrom|dateTo/) !== null
    expect(hasProvider && hasDate).toBe(true)
  })

  it('callback onFiltersChange (ou similar) passa todos os filtros de uma vez', () => {
    expect(filtersSrc).toMatch(/onFiltersChange|filters.*change|applyFilters/i)
  })
})

// ---------------------------------------------------------------------------
// 4g. "Limpar filtros" volta para estado default
// ---------------------------------------------------------------------------

describe('InboxFilters — limpar filtros', () => {
  it('tem botão "Limpar" ou "Limpar filtros"', () => {
    expect(filtersSrc).toMatch(/Limpar|limpar|Clear|clear/i)
  })

  it('limpar reseta todos os campos para valores padrão', () => {
    // Deve haver uma função que reseta provider, channel_id, datas
    expect(filtersSrc).toMatch(/resetFilters|clearFilters|handleClear|limpar/i)
  })

  it('botão limpar chama onFiltersChange com objeto vazio ou defaults', () => {
    expect(filtersSrc).toMatch(/onFiltersChange\s*\(\s*\{\s*\}|onFiltersChange\s*\(\s*default/i)
  })
})

// ---------------------------------------------------------------------------
// 4h. Estado vazio com filtros aplicados
// ---------------------------------------------------------------------------

describe('ConversationList — estado vazio com filtros', () => {
  it('mensagem de vazio menciona filtros quando há filtros ativos', () => {
    // A mensagem de vazio deve ser diferente quando filtros estão ativos
    const hasFilteredEmpty =
      listSrc.match(/nenhuma conversa.*filtro|filtros.*nenhuma/i) !== null ||
      filtersSrc.match(/nenhuma conversa.*filtro|filtros.*nenhuma/i) !== null ||
      pageSrc.match(/nenhuma conversa.*filtro|filtros.*nenhuma/i) !== null
    expect(hasFilteredEmpty).toBe(true)
  })

  it('estado vazio padrão mantém mensagem atual ("Nenhuma conversa encontrada")', () => {
    expect(listSrc).toContain('Nenhuma conversa encontrada')
  })
})

// ---------------------------------------------------------------------------
// 4i. Indicador visual de filtros ativos (chips / contador)
// ---------------------------------------------------------------------------

describe('InboxFilters — indicador de filtros ativos', () => {
  it('exibe contador ou badge de quantos filtros estão ativos', () => {
    const hasIndicator =
      filtersSrc.match(/activeFilters|filtrosAtivos|filterCount|active.*count/i) !== null ||
      filtersSrc.match(/badge|chip|pill|indicator/i) !== null ||
      filtersSrc.match(/\d+.*filtro|filtro.*ativo/i) !== null
    expect(hasIndicator).toBe(true)
  })

  it('indicador visual não aparece quando nenhum filtro está ativo', () => {
    // Deve haver lógica condicional para mostrar o indicador apenas quando há filtros
    expect(filtersSrc).toMatch(/activeCount\s*>\s*0|filtersActive|hasFilters|activeFilters\.length/i)
  })
})

// ---------------------------------------------------------------------------
// 4j. InboxFilters integrado no ConversationList ou page.tsx
// ---------------------------------------------------------------------------

describe('Integração do InboxFilters na página Inbox', () => {
  it('InboxFilters é importado na page.tsx ou ConversationList', () => {
    const isImportedInPage = pageSrc.includes('InboxFilters')
    const isImportedInList = listSrc.includes('InboxFilters')
    expect(isImportedInPage || isImportedInList).toBe(true)
  })

  it('filtros do InboxFilters são passados para useConversations', () => {
    const filtersPassedInPage =
      pageSrc.match(/provider.*useConversations|useConversations.*provider/i) !== null ||
      pageSrc.match(/filters.*useConversations|useConversations.*filters/i) !== null
    const filtersPassedInList =
      listSrc.match(/provider.*useConversations|useConversations.*provider/i) !== null
    expect(filtersPassedInPage || filtersPassedInList).toBe(true)
  })
})
