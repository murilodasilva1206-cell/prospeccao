import { z } from 'zod'

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

// Trim, collapse multiple spaces, enforce max length.
const SafeString = (maxLen: number) =>
  z
    .string()
    .trim()
    .max(maxLen, `Max ${maxLen} characters`)
    .transform((s) => s.replace(/\s+/g, ' '))

// Pagination — coerce because query params are always strings
const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20), // hard cap at 100 rows
})

// Boolean from query string — z.coerce.boolean() converts any non-empty string to true
// (because JS Boolean('false') === true). We need explicit string-to-boolean mapping.
const QueryBoolean = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1')
  .optional()

// ---------------------------------------------------------------------------
// /api/busca — search empresas (CNPJ registry)
// ---------------------------------------------------------------------------
export const BuscaQuerySchema = PaginationSchema.extend({
  // Localização
  uf: z.string().length(2).toUpperCase().optional(),          // e.g. SP, RJ, MG
  municipio: SafeString(150).optional(),                       // e.g. "São Paulo"

  // Atividade econômica
  cnae_principal: SafeString(20).optional(),                   // e.g. "8630-5/04"
  nicho: SafeString(100).optional(),                           // texto livre → mapeado para CNAE

  // Status cadastral (Receita Federal)
  situacao_cadastral: z
    .enum(['ATIVA', 'BAIXADA', 'INAPTA', 'SUSPENSA'])
    .default('ATIVA'),

  // Filtros de contato disponível
  tem_telefone: QueryBoolean,
  tem_email: QueryBoolean,

  // Whitelist — prevents ORDER BY injection via arbitrary column names
  orderBy: z
    .enum(['razao_social', 'municipio', 'cnpj_completo'])
    .default('razao_social'),
  orderDir: z.enum(['asc', 'desc']).default('asc'),
})

export type BuscaQuery = z.infer<typeof BuscaQuerySchema>

// ---------------------------------------------------------------------------
// /api/agente — AI agent chat
// ---------------------------------------------------------------------------
export const AgenteBodySchema = z.object({
  message: SafeString(1000), // cap at 1000 chars to limit token cost and injection surface
})

export type AgenteBody = z.infer<typeof AgenteBodySchema>

// ---------------------------------------------------------------------------
// /api/export — CSV download
// ---------------------------------------------------------------------------
export const ExportQuerySchema = z.object({
  formato: z.enum(['csv']).default('csv'),
  uf: z.string().length(2).toUpperCase().optional(),
  municipio: SafeString(150).optional(),
  cnae_principal: SafeString(20).optional(),
  nicho: SafeString(100).optional(),
  situacao_cadastral: z
    .enum(['ATIVA', 'BAIXADA', 'INAPTA', 'SUSPENSA'])
    .default('ATIVA'),
  tem_telefone: QueryBoolean,
  tem_email: QueryBoolean,
  orderBy: z
    .enum(['razao_social', 'municipio', 'cnpj_completo'])
    .default('razao_social'),
  orderDir: z.enum(['asc', 'desc']).default('asc'),
  // Hard cap: never export more than 5000 rows in a single request
  maxRows: z.coerce.number().int().min(1).max(5000).default(1000),
})

export type ExportQuery = z.infer<typeof ExportQuerySchema>

// ---------------------------------------------------------------------------
// AI response contract — validate before using any field from the AI
// ---------------------------------------------------------------------------
export const AgentIntentSchema = z.object({
  action: z.enum(['search', 'export', 'clarify', 'reject']),
  filters: BuscaQuerySchema.partial().optional(),
  confidence: z.number().min(0).max(1),
  message: SafeString(500).optional(), // only for clarify/reject actions
})

export type AgentIntent = z.infer<typeof AgentIntentSchema>
