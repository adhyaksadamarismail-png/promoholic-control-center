// Reset password akun yang SUDAH ADA di Supabase STAGING lewat Admin API resmi (auth.admin.updateUserById).
// Service role key dan password baru diketik tersembunyi; tidak ditampilkan, tidak disimpan, tidak dicatat.
// Tidak membuat user baru dan tidak menyentuh tabel profiles (role owner tetap).
// Pemakaian: node scripts/reset-owner-password.mjs
import { createClient } from '@supabase/supabase-js'

const STAGING_REF = 'vfscutetvasjsdunrorr'
const STAGING_URL = `https://${STAGING_REF}.supabase.co`
const USER_ID = '99c77d45-4b4c-486c-b990-fee7f1857893'
const USER_EMAIL = 'vierr@staff.promoholic.local'

/** Baca satu baris dari terminal tanpa menampilkan karakter yang diketik. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process
    if (!stdin.isTTY) return reject(new Error('Jalankan di terminal interaktif'))
    stdout.write(question)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          stdout.write('\n')
          return resolve(value)
        }
        if (ch === '\u0003') { stdout.write('\n'); process.exit(130) } // Ctrl+C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}

function fail(message) {
  console.error(`Gagal: ${message}`)
  process.exit(1)
}

// Kunci service role harus milik project staging (dicek dari isi JWT / format kunci, tanpa menampilkannya).
function keyMatchesStaging(key) {
  if (key.startsWith('sb_secret_')) return true // format baru tidak memuat ref; dicek lewat getUserById di bawah
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString())
    return payload.ref === STAGING_REF && payload.role === 'service_role'
  } catch {
    return false
  }
}

console.log(`Project : ${STAGING_REF} (promoholic-staging)`)
console.log(`Akun    : ${USER_EMAIL}`)

const key = (await askHidden('Service role key staging (tidak ditampilkan): ')).trim()
if (!key) fail('kunci kosong')
if (!keyMatchesStaging(key)) fail('kunci ini bukan service role key project staging')

const admin = createClient(STAGING_URL, key, { auth: { persistSession: false, autoRefreshToken: false } })

const { data: found, error: findError } = await admin.auth.admin.getUserById(USER_ID)
if (findError || !found?.user) fail('akun tidak ditemukan di project staging (cek kunci)')
if (found.user.email !== USER_EMAIL) fail('email akun tidak cocok; tidak ada yang diubah')

const password = await askHidden('Password baru (min. 10 karakter, tidak ditampilkan): ')
if (password.length < 10) fail('password minimal 10 karakter')
if ((await askHidden('Ulangi password baru: ')) !== password) fail('password tidak sama; tidak ada yang diubah')

const { error: updateError } = await admin.auth.admin.updateUserById(USER_ID, { password })
if (updateError) fail(updateError.message)

console.log('Berhasil: password akun owner sudah diganti. Login di staging memakai username "vierr".')
