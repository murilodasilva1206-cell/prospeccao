'use client'

// StatusTick — renders a delivery status icon for outbound messages.
// queued    → single clock (gray)
// sent      → single checkmark (gray)
// delivered → double checkmark (gray)
// read      → double checkmark (blue)
// failed    → X mark (red)

interface StatusTickProps {
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed'
  className?: string
}

export function StatusTick({ status, className = '' }: StatusTickProps) {
  const base = `inline-block w-4 h-4 ${className}`

  if (status === 'queued') {
    return (
      <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-label="Aguardando envio">
        <circle cx="12" cy="12" r="9" className="text-gray-400" />
        <path d="M12 7v5l3 3" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400" />
      </svg>
    )
  }

  if (status === 'sent') {
    return (
      <svg className={`${base} text-gray-400`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-label="Enviado">
        <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  if (status === 'delivered') {
    return (
      <svg className={`${base} text-gray-400`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-label="Entregue">
        <path d="M2 13l4 4L16 7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8 13l4 4L22 7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  if (status === 'read') {
    return (
      <svg className={`${base} text-blue-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-label="Lido">
        <path d="M2 13l4 4L16 7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8 13l4 4L22 7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  // failed
  return (
    <svg className={`${base} text-red-500`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-label="Falhou">
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9l-6 6M9 9l6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
