import { LoginForm } from './login-form'

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-wrap">
      <section className="flex flex-[1_1_420px] flex-col justify-center gap-6 bg-navy-900 p-6 text-white sm:p-14">
        <div className="flex flex-col gap-1">
          <span className="font-display text-4xl font-extrabold">
            PROMO<span className="text-orange-500">HOLIC</span>
          </span>
          <span className="text-xs uppercase tracking-[0.1em] text-[#8790a6]">Control Center · area internal</span>
        </div>
        <p className="max-w-md text-sm text-[#c5cbd9]">
          Masuk dengan akun yang dibuat owner. Peran owner atau staf ditentukan oleh akun Anda, bukan dipilih di halaman ini.
        </p>
      </section>
      <section className="flex flex-[1_1_420px] items-center justify-center p-5 sm:p-14">
        <LoginForm siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? ''} />
      </section>
    </main>
  )
}
