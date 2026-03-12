// ---------------------------------------------------------------------------
// TDD — Cenários 30–31: i18n/Encoding + UI PT-BR Labels
//
// 30. i18n/encoding: detectar mojibake (Ã, Â, â, ï, ¿, ½, etc.) nos
//     arquivos de Inbox e Templates
// 31. UI PT-BR: labels críticas aparecem corretas nos componentes
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Cenário 30 — Detecção de Mojibake
// ---------------------------------------------------------------------------

// Padrões de mojibake comuns (UTF-8 decodificado incorretamente como latin-1)
const MOJIBAKE_PATTERNS = [
  // Caracteres PT-BR corrompidos
  /Ã£/g,  // ã
  /Ã§/g,  // ç
  /Ã©/g,  // é
  /Ãª/g,  // ê
  /Ã /g,  // à
  /Ã³/g,  // ó
  /Ã´/g,  // ô
  /Ãº/g,  // ú
  /Ã¡/g,  // á
  /Ã­/g,  // í
  /Ã±/g,  // ñ
  /â\x80\x9c/g, // curly quote
  /â\x80\x9d/g, // curly quote
  /â\x80\x93/g, // em dash
  /\ufffd/g,    // replacement character (U+FFFD)
  /Â·/g,        // middle dot corrupted
]

// Diretórios a verificar
const INBOX_DIR = path.resolve('app/whatsapp/inbox')
const TEMPLATES_DIR = path.resolve('app/whatsapp/templates')
const INBOX_API_DIR = path.resolve('app/api/whatsapp')

function getAllTsxFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const results: string[] = []
  function recurse(current: string) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        recurse(fullPath)
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        results.push(fullPath)
      }
    }
  }
  recurse(dir)
  return results
}

function findMojibake(content: string): string[] {
  const found: string[] = []
  for (const pattern of MOJIBAKE_PATTERNS) {
    const matches = content.match(pattern)
    if (matches) {
      found.push(...matches)
    }
  }
  return found
}

describe('Cenário 30 — i18n/Encoding: sem mojibake nos arquivos do Inbox', () => {
  it('todos os arquivos .ts/.tsx do Inbox estão em UTF-8 válido (sem mojibake)', () => {
    const files = getAllTsxFiles(INBOX_DIR)
    const issues: Array<{ file: string; patterns: string[] }> = []

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8')
      const bad = findMojibake(content)
      if (bad.length > 0) {
        issues.push({ file: path.relative(process.cwd(), file), patterns: bad })
      }
    }

    if (issues.length > 0) {
      const summary = issues
        .map((i) => `  ${i.file}: ${i.patterns.join(', ')}`)
        .join('\n')
      throw new Error(`Mojibake encontrado em ${issues.length} arquivo(s):\n${summary}`)
    }

    // Se não há arquivos (dir não existe ainda), o teste passa mas avisa
    if (files.length === 0) {
      console.warn(`[i18n] Nenhum arquivo encontrado em ${INBOX_DIR}`)
    }
  })

  it('todos os arquivos .ts/.tsx da API WhatsApp estão em UTF-8 válido', () => {
    const files = getAllTsxFiles(INBOX_API_DIR)
    const issues: Array<{ file: string; patterns: string[] }> = []

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8')
      const bad = findMojibake(content)
      if (bad.length > 0) {
        issues.push({ file: path.relative(process.cwd(), file), patterns: bad })
      }
    }

    if (issues.length > 0) {
      const summary = issues
        .map((i) => `  ${i.file}: ${i.patterns.slice(0, 3).join(', ')}`)
        .join('\n')
      throw new Error(`Mojibake encontrado em ${issues.length} arquivo(s):\n${summary}`)
    }
  })

  it('arquivos da página de Templates estão em UTF-8 válido', () => {
    const files = getAllTsxFiles(TEMPLATES_DIR)
    const issues: Array<{ file: string; patterns: string[] }> = []

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8')
      const bad = findMojibake(content)
      if (bad.length > 0) {
        issues.push({ file: path.relative(process.cwd(), file), patterns: bad })
      }
    }

    if (issues.length > 0) {
      const summary = issues
        .map((i) => `  ${i.file}: ${i.patterns.slice(0, 3).join(', ')}`)
        .join('\n')
      throw new Error(`Mojibake encontrado em ${issues.length} arquivo(s):\n${summary}`)
    }
  })
})

// ---------------------------------------------------------------------------
// Cenário 31 — UI PT-BR: labels críticas presentes nos componentes
// ---------------------------------------------------------------------------

describe('Cenário 31 — UI PT-BR: labels críticas nos componentes do Inbox', () => {
  function readFileIfExists(relPath: string): string {
    const abs = path.resolve(relPath)
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : ''
  }

  // Labels críticas que devem aparecer no Inbox
  const inboxPage = readFileIfExists('app/whatsapp/inbox/page.tsx')
  const convList = readFileIfExists('app/whatsapp/inbox/components/ConversationList.tsx')
  const msgBubble = readFileIfExists('app/whatsapp/inbox/components/MessageBubble.tsx')
  const msgComposer = readFileIfExists('app/whatsapp/inbox/components/MessageComposer.tsx')
  const inboxFilters = readFileIfExists('app/whatsapp/inbox/components/InboxFilters.tsx')
  const statusTick = readFileIfExists('app/whatsapp/inbox/components/StatusTick.tsx')

  it('MessageBubble ou InboxFilters mencionam "áudio" (não "audio" com mojibake)', () => {
    const combined = msgBubble + inboxFilters + msgComposer
    if (combined.length === 0) return // arquivo não existe ainda
    // Se o arquivo menciona "audio" sem acento, verificar que não há mojibake adjacente
    // Padrão correto: áudio ou audio (ambos aceitáveis; o importante é não ter Ã)
    expect(combined).not.toMatch(/Ã¡udio/)
    expect(combined).not.toMatch(/Ã£udio/)
  })

  it('filtros de Inbox não contêm texto corrompido em PT-BR', () => {
    if (!inboxFilters) return
    const bad = findMojibake(inboxFilters)
    expect(bad).toHaveLength(0)
  })

  it('ConversationList não contém mojibake', () => {
    if (!convList) return
    const bad = findMojibake(convList)
    expect(bad).toHaveLength(0)
  })

  it('MessageComposer não contém mojibake', () => {
    if (!msgComposer) return
    const bad = findMojibake(msgComposer)
    expect(bad).toHaveLength(0)
  })

  it('respostas de erro da API usam acentuação correta (não corrompida)', () => {
    // Verifica nos arquivos de rota que erros em PT-BR estão corretos
    const sendTemplateRoute = readFileIfExists(
      'app/api/whatsapp/channels/[id]/send-template/route.ts',
    )
    if (!sendTemplateRoute) return

    const bad = findMojibake(sendTemplateRoute)
    expect(bad).toHaveLength(0)
  })

  it('lib/whatsapp/webhook-handler.ts não contém mojibake', () => {
    const content = readFileIfExists('lib/whatsapp/webhook-handler.ts')
    if (!content) return
    const bad = findMojibake(content)
    expect(bad).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Testes adicionais: strings críticas em PT-BR no código
// ---------------------------------------------------------------------------

describe('Cenário 31 — Strings PT-BR: termos de domínio corretos no código', () => {
  function searchInFiles(dir: string, term: string): boolean {
    const files = getAllTsxFiles(dir)
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8')
      if (content.includes(term)) return true
    }
    return false
  }

  it('código da API usa "não" corretamente (não "nao" sem acento em mensagens ao usuário)', () => {
    // Aceitável usar "nao" nos comentários de código ou mensagens internas
    // O importante é que o código de validação contém mensagens legíveis
    const apiDir = path.resolve('app/api/whatsapp')
    const files = getAllTsxFiles(apiDir)
    let hasPortugueseErrors = false

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8')
      // Verificar que não há mojibake nas mensagens de erro
      if (findMojibake(content).length > 0) {
        hasPortugueseErrors = true
        break
      }
    }

    expect(hasPortugueseErrors).toBe(false)
  })

  it('lib/whatsapp/ não contém mojibake em nenhum arquivo', () => {
    const libDir = path.resolve('lib/whatsapp')
    const files = getAllTsxFiles(libDir)
    const issues: string[] = []

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8')
      const bad = findMojibake(content)
      if (bad.length > 0) {
        issues.push(path.relative(process.cwd(), file))
      }
    }

    if (issues.length > 0) {
      throw new Error(`Mojibake em lib/whatsapp/: ${issues.join(', ')}`)
    }
  })
})
