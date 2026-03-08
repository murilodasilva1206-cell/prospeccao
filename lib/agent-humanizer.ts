// ---------------------------------------------------------------------------
// Agent humanizer — converts structured search results into natural PT-BR text.
//
// Deterministic (no LLM call) to keep latency and cost low.
// The output is shown in the chat panel after a successful agent search.
// ---------------------------------------------------------------------------

import type { PublicEmpresa } from '@/lib/mask-output'

interface HumanizeInput {
  total: number | null  // null when DB_SKIP_COUNT=true
  count: number         // how many returned in this page
  filters: {
    uf?: string
    municipio?: string
    cnae_principal?: string
    nicho?: string
    situacao_cadastral?: string
    tem_telefone?: boolean
    tem_email?: boolean
  }
  data: PublicEmpresa[]
}

/**
 * Builds a natural-language summary for display in the agent chat panel.
 * Returns both a headline and a subtitle.
 */
export function humanizeSearchResult(input: HumanizeInput): {
  headline: string
  subtitle: string
  hasCta: boolean
} {
  const { total, count, filters, data } = input

  // Location context
  const location = buildLocationString(filters)

  // Sector context
  const sector = filters.nicho
    ? filters.nicho.toLowerCase()
    : filters.cnae_principal
    ? `CNAE ${filters.cnae_principal}`
    : 'empresas'

  // With contact flag
  const contactHint =
    filters.tem_telefone && filters.tem_email
      ? ' com telefone e e-mail'
      : filters.tem_telefone
      ? ' com telefone'
      : filters.tem_email
      ? ' com e-mail'
      : ''

  // Primary headline
  const headline =
    total === null
      ? `Exibindo ${count} ${sector}${location}${contactHint}.`
      : total === 0
      ? `Nenhuma empresa encontrada para ${sector}${location}.`
      : total === 1
      ? `1 empresa encontrada — ${sector}${location}${contactHint}.`
      : `${total.toLocaleString('pt-BR')} empresas encontradas — ${sector}${location}${contactHint}.`

  // Subtitle
  let subtitle = ''
  if ((total === null || total > 0) && count > 0) {
    const showing =
      total === null
        ? `Exibindo ${count} resultados.`
        : count < total
        ? `Mostrando ${count} de ${total}.`
        : `Mostrando todas as ${total}.`
    const canContact = data.filter((e) => e.telefone1 || e.email).length
    const withContact =
      canContact > 0 ? ` ${canContact} com contato disponível.` : ''
    subtitle = showing + withContact
  }

  return {
    headline,
    subtitle,
    hasCta: (total === null || total > 0) && data.some((e) => e.telefone1 || e.telefone2),
  }
}

/**
 * Generates a first-contact message for a recipient from a text template.
 * Replaces placeholders with real lead data.
 */
export function applyMessageTemplate(
  template: string,
  recipient: {
    razaoSocial?: string
    nomeFantasia?: string
    municipio?: string
    nicho?: string
    cnae?: string
  },
): string {
  const nome = firstName(recipient.nomeFantasia ?? recipient.razaoSocial ?? '')
  const empresa = recipient.nomeFantasia || recipient.razaoSocial || 'sua empresa'
  const segmento = recipient.nicho ?? describeFromCnae(recipient.cnae) ?? 'seu segmento'
  const cidade = recipient.municipio ?? 'sua cidade'

  return template
    .replace(/\[Nome\]/g, nome)
    .replace(/\[Empresa\]/g, empresa)
    .replace(/\[segmento\]/g, segmento)
    .replace(/\[cidade\]/g, cidade)
}

/** Three built-in first-contact templates shown in the CampaignWizard. */
export const FIRST_CONTACT_TEMPLATES: { id: string; label: string; body: string }[] = [
  {
    id: 'tmpl_1',
    label: 'Curto e direto',
    body: 'Oi, [Nome]. Vi que a [Empresa] atua em [segmento]. Posso te mostrar em 1 minuto como geramos mais oportunidades com WhatsApp sem aumentar equipe?',
  },
  {
    id: 'tmpl_2',
    label: 'Proposta de valor',
    body: 'Olá, tudo bem? Trabalho com soluções para [segmento] que aumentam resposta de leads. Posso te enviar um resumo rápido com exemplos práticos?',
  },
  {
    id: 'tmpl_3',
    label: 'Convite para conversa',
    body: 'Oi, [Nome]! Atendemos empresas de [segmento] em [cidade] para melhorar conversão de contatos em vendas. Faz sentido uma conversa rápida esta semana?',
  },
]

/**
 * Normalizes a phone number to digits only for WhatsApp dispatch.
 * Strips non-digits, normalizes leading zeros, adds 55 country code if absent.
 */
export function normalizePhoneForWhatsApp(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 8) return null

  // Already has country code 55 (Brazil) — keep if length is correct
  if (digits.startsWith('55') && digits.length >= 12 && digits.length <= 13) {
    return digits
  }

  // Remove leading 0 (sometimes carriers prefix with 0)
  const stripped = digits.startsWith('0') ? digits.slice(1) : digits

  // DDD + number: 10 or 11 digits → prepend 55
  if (stripped.length >= 10 && stripped.length <= 11) {
    return `55${stripped}`
  }

  return null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildLocationString(filters: HumanizeInput['filters']): string {
  if (filters.municipio && filters.uf) return ` em ${filters.municipio}/${filters.uf}`
  if (filters.municipio) return ` em ${filters.municipio}`
  if (filters.uf) return ` em ${filters.uf}`
  return ''
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name
}

function describeFromCnae(cnae: string | undefined): string | null {
  if (!cnae) return null
  // Very basic mapping for the most common CNAEs; expand as needed
  switch (cnae.slice(0, 4)) {
    case '8630': return 'saúde'
    case '5611': return 'alimentação'
    case '9313': return 'academia'
    case '4771': return 'farmácias'
    case '8599': return 'educação'
    case '4330': return 'construção'
    default: return null
  }
}
