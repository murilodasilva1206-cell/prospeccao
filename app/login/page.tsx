import { Suspense } from "react"
import LoginPageClient from "./LoginPageClient"

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-zinc-500">Carregando...</div>}>
      <LoginPageClient />
    </Suspense>
  )
}
